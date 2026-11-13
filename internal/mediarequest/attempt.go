// Package mediarequest ведёт жизненный цикл одной попытки генерации у выбранного провайдера
// (возможности, подготовка, единственная отправка, получение оригиналов, ручной результат при
// неизвестном исходе) и инструмент media_request.
//
// Сервис здесь не известен: команды, разбор ответов и загрузку выполняет адаптер из
// internal/mediaadapters (возможности — интерфейсы internal/mediaapi). Пакет ведёт состояние
// attempt.json, файловый замок, SHA, единственную отправку и сохранность оригиналов. Файлы
// попытки, статусы, тексты ошибок и вывод CLI зафиксированы эталонами
// testdata/golden/media-request.
//
// Проект передаётся параметром root. Вызовы сервиса получают context.Context: отмена задания
// прерывает опрос и ожидание. Отмена во время отправки оставляет попытку submitting (как обрыв
// процесса), а не submission_unknown; обе формы одинаково считаются неизвестным исходом. Адаптер
// без Submit отклоняется до записи submitting, не обращаясь к сервису.
package mediarequest

import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"strings"
	"time"

	"songframe/internal/mediaadapters"
	"songframe/internal/mediaapi"
	"songframe/internal/requestsnapshot"
	"songframe/internal/toolrt"
)

// Статусы. pending — ожидание продолжения того же задания; pollStatuses — допустимые ответы
// poll адаптера (completed общий код превращает в получение оригиналов); Terminal — итоговые.
var (
	pending      = map[string]bool{"running": true, "outputs_pending": true, "watermark_free_pending": true}
	pollStatuses = map[string]bool{"running": true, "outputs_pending": true, "watermark_free_pending": true, "failed": true, "completed": true}
	// Terminal — статусы, после которых watch перестаёт ждать попытку.
	Terminal = map[string]bool{"downloaded": true, "failed": true}
)

// Тексты отказов (исключение toolrt ValueError): CLI печатает их в stderr как есть.
const (
	textWorkDir          = "Рабочая папка должна находиться внутри plan/batches, plan/awaiting, plan/reference-images или временной папки ОС."
	textWorkDirProtected = "Рабочая папка не может заменять исходники или аниматик."
	textNoLocalFile      = "Нет локального файла подготовленной попытки."
	textBusy             = "Эту попытку уже обрабатывает другой процесс."
	textNoProvider       = "В подготовленном запросе нет provider подключённого адаптера генерации."
	textRequestChanged   = "Подготовленный запрос изменён; нужна новая попытка и новое согласование."
	textInputChanged     = "Промпт или вход изменён; отправка запрещена."
	textBadID            = "Некорректный generationId."
	textTimeout          = "Таймаут должен быть положительным."
	textAlreadySent      = "Эта попытка уже отправлялась; используйте resume. При неизвестной отправке повтор запрещён."
	textConfirm          = "Нужно подтверждение SHA-256 именно подготовленного запроса."
	textUnknownOutcome   = "Исход отправки неизвестен. Не повторяйте запрос; выясните ID задания и продолжите через resume."
	textEmptyResult      = "Получен пустой результат."
	textImageFormat      = "Неизвестный формат изображения результата: ожидается PNG, JPEG или WebP по сигнатуре файла."
	textVideoFormat      = "Ожидается видео MP4: файл не похож на MP4 по сигнатуре."
	textSymlink          = "Сохранённый оригинал изображения не должен быть символической ссылкой."
	textExtension        = "Расширение сохранённого оригинала не соответствует изображению. Оригинал оставлен без изменений."
	textResultChanged    = "Сохранённый результат изменился."
	textExists           = "Выходной файл уже существует; он не будет перезаписан."
	textVideoSave        = "Не удалось сохранить результат. Повторите resume для того же задания; существующие файлы не перезаписываются."
	textImageSave        = "Не удалось сохранить оригинал PNG/JPEG/WebP. Повторите resume того же задания; существующие файлы не перезаписываются."
	textWaitLimits       = "Ожидание ограничено 60 секундами; интервал — от 1 до 60."
	textOtherID          = "У попытки уже другой ID."
	textManualID         = "Ручное восстановление ID разрешено только после неизвестной отправки."
	textNoID             = "Нет ID задания; отправку через resume выполнить нельзя."
	textPollFailed       = "Не удалось запросить состояние. ID сохранён; повторите resume, не submit."
	textNotUnknown       = "Действие доступно только попытке с неизвестным исходом отправки и без ID задания."
	textWatchLimits      = "Ожидание — от 1 до 120 минут, интервал — от 5 до 300 секунд."
	textWatchTimeout     = "время ожидания вышло; задание не отменено, повторите watch"
	textKind             = "Вид медиа должен быть image или video."
	textManualRequest    = "Запрос ручной генерации не отправляется сервису: загрузите видео, созданное по пакету."
	textNotManual        = "Действие доступно только пакету ручной генерации, ещё не получившему видео."
	textNotManualResult  = "Заменить можно только видео, загруженное вручную в пакет ручной генерации."
	textManualSource     = "Укажите источник видео."
	textManualCost       = "Стоимость должна быть неотрицательным числом."
	textManualCostUnit   = "Единица стоимости: credits, RUB или USD."
)

func valueError(message string) error { return toolrt.New(toolrt.ValueError, message) }

// Часы попытки: монотонное время в секундах, ожидание с отменой и время UTC отметок решений.
// Тесты и эталоны подменяют их детерминированными (ожидание продвигает часы), чтобы опрос
// с --wait-seconds и watch проверялись без настоящих пауз.
var (
	started   = time.Now()
	monotonic = func() float64 { return time.Since(started).Seconds() }
	sleep     = func(ctx context.Context, seconds float64) error {
		timer := time.NewTimer(time.Duration(seconds * float64(time.Second)))
		defer timer.Stop()
		select {
		case <-ctx.Done():
			return ctx.Err()
		case <-timer.C:
			return nil
		}
	}
	utcNow = func() time.Time { return time.Now().UTC() }
)

// hooks — точки внесения сбоев для тестов (обрыв процесса посреди получения). nil в работе.
// journal вызывается перед каждой записью attempt.json, link — перед публикацией жёсткой ссылкой
// оригинала (файлы original*). Тест прерывает работу panic: отложенные снятие замка и удаление
// временных папок выполняются, как при обрыве процесса.
var hooks struct {
	journal func(state *toolrt.Dict)
	link    func(destination string)
}

// writeState атомарно записывает журнал попытки attempt.json.
func writeState(directory string, state *toolrt.Dict) error {
	if hooks.journal != nil {
		hooks.journal(state)
	}
	return requestsnapshot.AtomicJSON(filepath.Join(directory, "attempt.json"), state)
}

// link публикует source жёсткой ссылкой destination без перезаписи (существующая цель —
// исключение toolrt OSError).
func link(source, destination string) error {
	if hooks.link != nil && strings.HasPrefix(filepath.Base(destination), "original") {
		hooks.link(destination)
	}
	if err := os.Link(source, destination); err != nil {
		return toolrt.OSErrorFrom(err, source)
	}
	return nil
}

// isSymlink сообщает, что путь — символическая ссылка; ошибка lstat — false.
func isSymlink(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode()&os.ModeSymlink != 0
}

// tempDir — временная папка ОС, в которой разрешены попытки вне проекта.
func tempDir() string { return os.TempDir() }

// WorkPath — проверенная рабочая папка попытки. Попытка — внутри
// plan/batches, plan/awaiting (отложенная попытка запускается прямо из очереди),
// plan/reference-images (архив попыток генерации референса) или временной папки ОС; сами
// корни этих папок проекта, исходники и аниматик попыткой быть не могут.
func WorkPath(root, value string) (string, error) {
	path := toolrt.ResolvePath(value)
	allowed := []string{
		toolrt.ResolvePath(toolrt.JoinPath(root, "plan/batches")),
		toolrt.ResolvePath(toolrt.JoinPath(root, "plan/awaiting")),
		toolrt.ResolvePath(toolrt.JoinPath(root, "plan/reference-images")),
	}
	inside, isRoot := false, false
	for _, base := range allowed {
		inside = inside || toolrt.IsRelativeTo(path, base)
		isRoot = isRoot || path == base
	}
	inside = inside || toolrt.IsRelativeTo(path, toolrt.ResolvePath(tempDir()))
	if isRoot || !inside {
		return "", valueError(textWorkDir)
	}
	for _, name := range []string{"assets", "source", "plan/animatic"} {
		if toolrt.IsRelativeTo(path, toolrt.ResolvePath(toolrt.JoinPath(root, name))) {
			return "", valueError(textWorkDirProtected)
		}
	}
	return path, nil
}

// insideFile — файл попытки внутри её папки после разрешения ссылок.
func insideFile(directory string, name any) (string, error) {
	text, ok := name.(string)
	if !ok {
		return "", toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(name))
	}
	path := toolrt.ResolvePath(toolrt.JoinPath(directory, text))
	if !toolrt.IsRelativeTo(path, toolrt.ResolvePath(directory)) || !toolrt.IsFile(path) {
		return "", valueError(textNoLocalFile)
	}
	return path, nil
}

// withLock — неблокирующий замок файла .lock попытки на время действия.
// Занятая попытка отклоняется сразу (повторная отправка не ждёт первую).
func withLock(directory string, action func() error) error {
	path := filepath.Join(directory, ".lock")
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o666)
	if err != nil {
		return toolrt.OSErrorFrom(err, path)
	}
	defer file.Close()
	if err := lockFile(file); err != nil {
		if errors.Is(err, errBusy) {
			return valueError(textBusy)
		}
		return toolrt.OSErrorFrom(err, path)
	}
	defer unlockFile(file)
	return action()
}

// errBusy — замок держит другой процесс (EAGAIN/EACCES/EDEADLK).
var errBusy = errors.New("занято")

// readJSON читает JSON-файл в значения toolrt (toolrt.LoadJSONFile).
func readJSON(path string) (any, error) { return toolrt.LoadJSONFile(path) }

// item — значение ключа (toolrt.Item): исключение KeyError или TypeError на чужой форме.
func item(container any, key string) (any, error) { return toolrt.Item(container, key) }

// get — значение ключа или nil, если его нет (toolrt.DictGet; у не-словаря — исключение
// AttributeError).
func get(container any, key string) (any, error) { return toolrt.DictGet(container, key, nil) }

// LoadAttempt читает зафиксированный запрос и журнал попытки.
// Запрос должен указывать провайдера подключённого адаптера и совпадать с request_sha256
// журнала; с verifyInputs сверяются хеши промпта и входов.
func LoadAttempt(directory string, verifyInputs bool) (*toolrt.Dict, *toolrt.Dict, error) {
	requestPath, err := insideFile(directory, "request.json")
	if err != nil {
		return nil, nil, err
	}
	requestValue, err := readJSON(requestPath)
	if err != nil {
		return nil, nil, err
	}
	provider, err := get(requestValue, "provider")
	if err != nil {
		return nil, nil, err
	}
	// Пакету ручной генерации сервис не нужен: видео создаёт пользователь, адаптера у способа
	// «Вручную вне приложения» нет.
	mode, _ := toolrt.DictGet(requestValue, "mode", nil)
	manual := mode == "manual"
	if !mediaadapters.Known(provider) && !manual {
		return nil, nil, valueError(textNoProvider)
	}
	request := requestValue.(*toolrt.Dict)
	statePath, err := insideFile(directory, "attempt.json")
	if err != nil {
		return nil, nil, err
	}
	stateValue, err := readJSON(statePath)
	if err != nil {
		return nil, nil, err
	}
	digest, err := requestsnapshot.Digest(request)
	if err != nil {
		return nil, nil, err
	}
	saved, err := item(stateValue, "request_sha256")
	if err != nil {
		return nil, nil, err
	}
	if !toolrt.Equal(digest, saved) {
		return nil, nil, valueError(textRequestChanged)
	}
	if verifyInputs {
		prompt, err := item(request, "prompt")
		if err != nil {
			return nil, nil, err
		}
		inputs, err := item(request, "inputs")
		if err != nil {
			return nil, nil, err
		}
		entries, err := toolrt.Iter(inputs)
		if err != nil {
			return nil, nil, err
		}
		for _, entry := range append([]any{prompt}, entries...) {
			name, err := item(entry, "path")
			if err != nil {
				return nil, nil, err
			}
			path, err := insideFile(directory, name)
			if err != nil {
				return nil, nil, err
			}
			actual, err := requestsnapshot.FileSHA(path)
			if err != nil {
				return nil, nil, err
			}
			expected, err := item(entry, "sha256")
			if err != nil {
				return nil, nil, err
			}
			if !toolrt.Equal(actual, expected) {
				return nil, nil, valueError(textInputChanged)
			}
		}
	}
	return request, stateValue.(*toolrt.Dict), nil
}

// adapterOf — адаптер провайдера из поля provider зафиксированного запроса.
func adapterOf(request *toolrt.Dict) (mediaadapters.Adapter, error) {
	provider, err := item(request, "provider")
	if err != nil {
		return nil, err
	}
	return mediaadapters.Lookup(provider)
}

// Prepare — замораживает спецификацию в новой папке попытки.
// Общую форму проверяет requestsnapshot, ограничения сервиса и промпта — адаптер провайдера
// спецификации до создания папки; поля FrozenFields адаптера входят в запрос и SHA, предупреждения
// о промпте — в warnings результата. Сервис не вызывается.
func Prepare(root, request, directory string) (*toolrt.Dict, error) {
	value, err := readJSON(request)
	if err != nil {
		return nil, err
	}
	if err := requestsnapshot.ValidateSpec(value); err != nil {
		return nil, err
	}
	spec := value.(*toolrt.Dict)
	service, err := mediaadapters.Lookup(spec.Value("provider"))
	if err != nil {
		return nil, err
	}
	if validator, ok := service.(mediaapi.SpecValidator); ok {
		if err := validator.ValidateSpec(spec); err != nil {
			return nil, err
		}
	}
	promptPath := toolrt.JoinPath(filepath.Dir(toolrt.ResolvePath(request)), spec.Value("prompt_file").(string))
	data, err := os.ReadFile(promptPath)
	if err != nil {
		return nil, toolrt.OSErrorFrom(err, promptPath)
	}
	prompt, err := toolrt.DecodeUTF8(data)
	if err != nil {
		return nil, err
	}
	warnings := []string{}
	if validator, ok := service.(mediaapi.PromptValidator); ok {
		if warnings, err = validator.ValidatePrompt(prompt); err != nil {
			return nil, err
		}
	}
	workDir, err := WorkPath(root, directory)
	if err != nil {
		return nil, err
	}
	var frozen *toolrt.Dict
	if fielder, ok := service.(mediaapi.FrozenFielder); ok {
		frozen = fielder.FrozenFields()
	}
	prepared, err := requestsnapshot.Prepare(request, workDir, frozen)
	if err != nil {
		return nil, err
	}
	list := prepared.Value("warnings").([]any)
	for _, warning := range warnings {
		list = append(list, warning)
	}
	prepared.Set("warnings", list)
	return prepared, nil
}

// Status — только локальный журнал попытки, без обращения к сервису.
func Status(root, directory string) (*toolrt.Dict, error) {
	workDir, err := WorkPath(root, directory)
	if err != nil {
		return nil, err
	}
	_, state, err := LoadAttempt(workDir, false)
	return state, err
}

// identifier — ID задания печатаемой ASCII-строкой до 2048 символов, без
// ведущего «-» и схемы URL (подписанный адрес вместо ID не сохраняется).
func identifier(value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", valueError(textBadID)
	}
	length := toolrt.Len(text)
	if length < 1 || length > 2048 || strings.HasPrefix(text, "-") || strings.Contains(text, "://") {
		return "", valueError(textBadID)
	}
	for _, r := range toolrt.Runes(text) {
		if r < 33 || r > 126 {
			return "", valueError(textBadID)
		}
	}
	return text, nil
}

// positive — конечное положительное значение таймаута.
func positive(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) && value > 0 }

// Submit — единственная отправка подготовленной
// попытки по подтверждению её SHA. Перед вызовом адаптера сверяются хеши промпта и входов и
// записывается submitting; generation_id сохраняется сразу после ответа. Повтор запрещён,
// включая submitting и submission_unknown. Явный отказ и «отправка не начиналась» возвращают
// попытку в prepared (отказ — с last_rejection); прочие сбои — submission_unknown.
func Submit(ctx context.Context, root, directory, confirmation string, timeout float64) (*toolrt.Dict, error) {
	workDir, err := WorkPath(root, directory)
	if err != nil {
		return nil, err
	}
	if !positive(timeout) {
		return nil, valueError(textTimeout)
	}
	var result *toolrt.Dict
	err = withLock(workDir, func() error {
		request, state, err := LoadAttempt(workDir, true)
		if err != nil {
			return err
		}
		if toolrt.Equal(request.Value("mode"), "manual") {
			return valueError(textManualRequest)
		}
		status, err := item(state, "status")
		if err != nil {
			return err
		}
		if !toolrt.Equal(status, "prepared") || toolrt.Truthy(state.Value("generation_id")) {
			return valueError(textAlreadySent)
		}
		if !toolrt.Equal(confirmation, state.Value("request_sha256")) {
			return valueError(textConfirm)
		}
		service, err := adapterOf(request)
		if err != nil {
			return err
		}
		submitter, ok := service.(mediaapi.Submitter)
		if !ok {
			return unsupported(request.Value("provider"))
		}
		state.Set("status", "submitting")
		if tracer, ok := service.(mediaapi.TaskTracer); ok && tracer.TaskTraceID() && !state.Has("task_trace_id") {
			// Один идентификатор на попытку: сервис связывает по нему загрузки, отправку и опрос.
			state.Set("task_trace_id", uuid7())
		}
		if err := writeState(workDir, state); err != nil {
			return err
		}
		answer, sendErr := submitter.Submit(ctx, workDir, request, state.Clone(), mediaapi.Seconds(timeout))
		var generationID string
		if sendErr == nil {
			generationID, sendErr = identifier(answer.GenerationID)
		}
		if sendErr != nil {
			var rejected *mediaapi.RejectedRequest
			switch {
			case errors.As(sendErr, &rejected):
				// Явный отказ без ID задания — до оплаты: попытка остаётся неотправленной.
				state.Set("status", "prepared")
				state.Set("last_rejection", rejected.Message)
				if err := writeState(workDir, state); err != nil {
					return err
				}
				return &mediaapi.RejectedRequest{Message: "Сервис отклонил запрос до оплаты: " + rejected.Message + " Генерация не создана, кредиты не списаны."}
			case mediaapi.IsNotSubmitted(sendErr):
				state.Set("status", "prepared")
				if err := writeState(workDir, state); err != nil {
					return err
				}
				return sendErr
			case ctx.Err() != nil:
				// Отмена задания посреди отправки — как обрыв процесса: submitting остаётся.
				return ctx.Err()
			}
			// Любой другой сбой после начала отправки — неизвестный исход, а не доказанное
			// отсутствие списания.
			state.Set("status", "submission_unknown")
			if err := writeState(workDir, state); err != nil {
				return err
			}
			return valueError(textUnknownOutcome)
		}
		state.Set("status", "submitted")
		state.Set("generation_id", generationID)
		switch credits := answer.CreditsConsumed.(type) {
		case toolrt.Int:
			state.Set("credits_consumed", credits)
		case float64:
			if !math.IsNaN(credits) && !math.IsInf(credits, 0) {
				state.Set("credits_consumed", credits)
			}
		}
		if err := writeState(workDir, state); err != nil {
			return err
		}
		result = state
		return nil
	})
	return result, err
}

// unsupported — отказ, когда у адаптера нет нужной возможности.
func unsupported(provider any) error {
	return valueError("Провайдер " + toolrt.Repr(provider) + " не поддерживает это действие.")
}

// publish — адаптер пишет байты результата во временный
// .part рядом, общий код публикует его жёсткой ссылкой без перезаписи. Пустой результат
// отклоняется; временный файл удаляется в любом случае. Видео не хешируется и не исследуется.
func publish(ctx context.Context, fetcher mediaapi.Fetcher, output, destination string) error {
	temporary := destination + ".part"
	defer os.Remove(temporary)
	if err := fetcher.Fetch(ctx, output, temporary); err != nil {
		return err
	}
	info, err := os.Stat(temporary)
	if err != nil {
		return toolrt.OSErrorFrom(err, temporary)
	}
	if info.Size() == 0 {
		return valueError(textEmptyResult)
	}
	if err := os.Link(temporary, destination); err != nil {
		return toolrt.OSErrorFrom(err, temporary)
	}
	return nil
}

// header — первые 12 байт файла.
func header(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, toolrt.OSErrorFrom(err, path)
	}
	defer file.Close()
	data := make([]byte, 12)
	count, _ := file.Read(data)
	return data[:count], nil
}

// imageExtension — контейнер оригинала по сигнатуре, а не по адресу.
func imageExtension(path string) (string, error) {
	data, err := header(path)
	if err != nil {
		return "", err
	}
	switch {
	case bytes.HasPrefix(data, []byte("\x89PNG\r\n\x1a\n")):
		return ".png", nil
	case bytes.HasPrefix(data, []byte("\xff\xd8\xff")):
		return ".jpg", nil
	case bytes.HasPrefix(data, []byte("RIFF")) && len(data) >= 12 && string(data[8:12]) == "WEBP":
		return ".webp", nil
	}
	return "", valueError(textImageFormat)
}

// videoExtension — MP4 по ftyp.
func videoExtension(path string) (string, error) {
	data, err := header(path)
	if err != nil {
		return "", err
	}
	if len(data) < 8 || string(data[4:8]) != "ftyp" {
		return "", valueError(textVideoFormat)
	}
	return ".mp4", nil
}

// size — размер файла в байтах целым toolrt.Int (в attempt.json — целое JSON).
func size(path string) (toolrt.Int, error) {
	info, err := os.Stat(path)
	if err != nil {
		return toolrt.Int{}, toolrt.OSErrorFrom(err, path)
	}
	return toolrt.NewInt(info.Size()), nil
}

// verifySavedImage — сохранённый оригинал без переименования и перекодирования.
func verifySavedImage(directory string, entry *toolrt.Dict) error {
	name, err := item(entry, "path")
	if err != nil {
		return err
	}
	if text, ok := name.(string); ok && isSymlink(toolrt.JoinPath(directory, text)) {
		return valueError(textSymlink)
	}
	target, err := insideFile(directory, name)
	if err != nil {
		return err
	}
	actual, err := imageExtension(target)
	if err != nil {
		return err
	}
	suffix := strings.ToLower(toolrt.PathSuffix(name.(string)))
	if suffix != actual && !(actual == ".jpg" && suffix == ".jpeg") {
		return valueError(textExtension)
	}
	bytesValue, err := item(entry, "bytes")
	if err != nil {
		return err
	}
	actualSize, err := size(target)
	if err != nil {
		return err
	}
	if !toolrt.Equal(actualSize, bytesValue) {
		return valueError(textResultChanged)
	}
	if expected := entry.Value("sha256"); toolrt.Truthy(expected) {
		digest, err := requestsnapshot.FileSHA(target)
		if err != nil {
			return err
		}
		if !toolrt.Equal(digest, expected) {
			return valueError(textResultChanged)
		}
	}
	return nil
}

// verifyDownload — зарегистрированный результат на месте и не изменился.
func verifyDownload(directory string, request *toolrt.Dict, value any) error {
	entry, ok := value.(*toolrt.Dict)
	if !ok {
		return toolrt.Raise(toolrt.TypeError, "нельзя обратиться по индексу или ключу: %s", toolrt.TypeName(value))
	}
	if toolrt.Equal(request.Value("kind"), "image") {
		return verifySavedImage(directory, entry)
	}
	name, err := item(entry, "path")
	if err != nil {
		return err
	}
	target, err := insideFile(directory, name)
	if err != nil {
		return err
	}
	actualSize, err := size(target)
	if err != nil {
		return err
	}
	expected, err := item(entry, "bytes")
	if err != nil {
		return err
	}
	if !toolrt.Equal(actualSize, expected) {
		return valueError(textResultChanged)
	}
	return nil
}

// receiveImage сначала получает исходные байты, затем фиксирует намерение
// (номер, путь, размер, SHA) и публикует оригинал. После обрыва между публикацией и журналом
// принимается только тот же оригинал; чужой существующий файл не становится результатом.
func receiveImage(ctx context.Context, fetcher mediaapi.Fetcher, output, directory, stem string, number int, state *toolrt.Dict) (*toolrt.Dict, error) {
	numberValue := toolrt.NewInt(int64(number))
	if pendingDownload, ok := state.Value("pending_download").(*toolrt.Dict); ok && pendingDownload.Len() > 0 {
		names := map[string]bool{}
		for _, extension := range []string{".png", ".jpg", ".jpeg", ".webp"} {
			names[stem+extension] = true
		}
		path, isString := pendingDownload.Value("path").(string)
		if toolrt.Equal(pendingDownload.Value("number"), numberValue) && isString && names[path] {
			target := toolrt.JoinPath(directory, path)
			if toolrt.Exists(target) || isSymlink(target) {
				proof := pendingDownload
				if !proof.Has("bytes") {
					targetSize, err := size(target)
					if err != nil {
						return nil, err
					}
					proof = proof.Clone()
					proof.Set("bytes", targetSize)
				}
				if err := verifySavedImage(directory, proof); err != nil {
					return nil, err
				}
				return proof, nil
			}
		}
	}
	temporary, err := os.MkdirTemp(directory, ".image-download-")
	if err != nil {
		return nil, toolrt.OSErrorFrom(err, directory)
	}
	defer os.RemoveAll(temporary)
	raw := filepath.Join(temporary, "original.raw")
	if err := publish(ctx, fetcher, output, raw); err != nil {
		return nil, err
	}
	extension, err := imageExtension(raw)
	if err != nil {
		return nil, err
	}
	name := stem + extension
	target := filepath.Join(directory, name)
	if toolrt.Exists(target) || isSymlink(target) {
		return nil, valueError(textExists)
	}
	rawSize, err := size(raw)
	if err != nil {
		return nil, err
	}
	digest, err := requestsnapshot.FileSHA(raw)
	if err != nil {
		return nil, err
	}
	proof := toolrt.NewDict()
	proof.Set("number", numberValue)
	proof.Set("path", name)
	proof.Set("bytes", rawSize)
	proof.Set("sha256", digest)
	// Хеш и размер записываются до атомарной публикации.
	state.Set("pending_download", proof)
	if err := writeState(directory, state); err != nil {
		return nil, err
	}
	if err := link(raw, target); err != nil {
		return nil, err
	}
	return proof, nil
}

// receiveVideo записывает намерение до скачивания; если процесс оборвался
// после публикации файла, повтор принимает этот файл.
func receiveVideo(ctx context.Context, fetcher mediaapi.Fetcher, output, directory, name string, number int, state *toolrt.Dict) (*toolrt.Dict, error) {
	intent := toolrt.NewDict()
	intent.Set("number", toolrt.NewInt(int64(number)))
	intent.Set("path", name)
	target := filepath.Join(directory, name)
	if toolrt.Exists(target) {
		info, err := os.Stat(target)
		if !toolrt.Equal(state.Value("pending_download"), intent) || isSymlink(target) || err != nil || info.Size() == 0 {
			return nil, valueError(textExists)
		}
	} else {
		state.Set("pending_download", intent)
		if err := writeState(directory, state); err != nil {
			return nil, err
		}
		if err := publish(ctx, fetcher, output, target); err != nil {
			state.Set("status", "download_pending")
			if err := writeState(directory, state); err != nil {
				return nil, err
			}
			return nil, valueError(textVideoSave)
		}
	}
	targetSize, err := size(target)
	if err != nil {
		return nil, err
	}
	result := toolrt.NewDict()
	result.Set("number", toolrt.NewInt(int64(number)))
	result.Set("path", name)
	result.Set("bytes", targetSize)
	return result, nil
}

// receive сохраняет все результаты по порядку; зарегистрированные повторно не
// скачиваются. Итог — downloaded.
func receive(ctx context.Context, fetcher mediaapi.Fetcher, directory string, request, state *toolrt.Dict, outputs []string) error {
	state.Set("status", "downloading")
	if err := writeState(directory, state); err != nil {
		return err
	}
	for index, output := range outputs {
		number := index + 1
		downloads, err := toolrt.Iter(state.Value("downloads"))
		if err != nil {
			return err
		}
		var existing any
		for _, entry := range downloads {
			value, err := item(entry, "number")
			if err != nil {
				return err
			}
			if toolrt.Equal(value, toolrt.NewInt(int64(number))) {
				existing = entry
				break
			}
		}
		if toolrt.Truthy(existing) {
			if err := verifyDownload(directory, request, existing); err != nil {
				return err
			}
			continue
		}
		stem := "original"
		if len(outputs) != 1 {
			stem = "original-" + twoDigits(number)
		}
		var original *toolrt.Dict
		if toolrt.Equal(request.Value("kind"), "image") {
			original, err = receiveImage(ctx, fetcher, output, directory, stem, number, state)
			if err != nil {
				state.Set("status", "download_pending")
				if err := writeState(directory, state); err != nil {
					return err
				}
				return valueError(textImageSave)
			}
		} else {
			original, err = receiveVideo(ctx, fetcher, output, directory, stem+".mp4", number, state)
			if err != nil {
				return err
			}
		}
		list, _ := state.Value("downloads").([]any)
		state.Set("downloads", append(list, original))
		state.Delete("pending_download")
		if err := writeState(directory, state); err != nil {
			return err
		}
	}
	state.Set("status", "downloaded")
	return writeState(directory, state)
}

// twoDigits — номер не короче двух цифр, с ведущим нулём.
func twoDigits(number int) string {
	text := toolrt.NewInt(int64(number)).String()
	if len(text) < 2 {
		return "0" + text
	}
	return text
}

// serviceStatus — допустимая запись статуса сервиса: только строчные латинские буквы и «_».
var serviceStatus = regexp.MustCompile(`^[a-z_]{1,40}$`)

// Resume — опрос только сохранённого ID (один раз либо в пределах waitSeconds с шагом interval) и
// получение готовых оригиналов. generationID привязывает известный ID неизвестной отправки. Ручной
// результат продолжается без ID и без обращения к сервису.
func Resume(ctx context.Context, root, directory, generationID string, waitSeconds, interval, timeout float64) (*toolrt.Dict, error) {
	workDir, err := WorkPath(root, directory)
	if err != nil {
		return nil, err
	}
	return resume(ctx, workDir, generationID, waitSeconds, interval, timeout)
}

func resume(ctx context.Context, workDir, generationID string, waitSeconds, interval, timeout float64) (*toolrt.Dict, error) {
	if !positive(timeout) {
		return nil, valueError(textTimeout)
	}
	if !(0 <= waitSeconds && waitSeconds <= 60) || !(1 <= interval && interval <= 60) {
		return nil, valueError(textWaitLimits)
	}
	var result *toolrt.Dict
	err := withLock(workDir, func() error {
		request, state, err := LoadAttempt(workDir, false)
		if err != nil {
			return err
		}
		if generationID != "" {
			id, err := identifier(generationID)
			if err != nil {
				return err
			}
			saved := state.Value("generation_id")
			if saved != nil && !toolrt.Equal(saved, id) {
				return valueError(textOtherID)
			}
			if !toolrt.Truthy(saved) {
				status, err := item(state, "status")
				if err != nil {
					return err
				}
				if !toolrt.Equal(status, "submitting") && !toolrt.Equal(status, "submission_unknown") {
					return valueError(textManualID)
				}
			}
			state.Set("generation_id", id)
			state.Set("status", "submitted")
			if err := writeState(workDir, state); err != nil {
				return err
			}
		}
		if !toolrt.Truthy(state.Value("generation_id")) {
			manual := false
			if toolrt.Truthy(state.Value("manual_result")) {
				status, err := item(state, "status")
				if err != nil {
					return err
				}
				manual = toolrt.Equal(status, "downloaded")
			}
			if !manual {
				return valueError(textNoID)
			}
		}
		status, err := item(state, "status")
		if err != nil {
			return err
		}
		if toolrt.Equal(status, "downloaded") {
			downloads, err := toolrt.Iter(state.Value("downloads"))
			if err != nil {
				return err
			}
			for _, entry := range downloads {
				if err := verifyDownload(workDir, request, entry); err != nil {
					return err
				}
			}
			result = state
			return nil
		}
		if toolrt.Equal(status, "failed") {
			result = state
			return nil
		}
		service, err := adapterOf(request)
		if err != nil {
			return err
		}
		deadline := monotonic() + waitSeconds
		for {
			answer, err := poll(ctx, service, workDir, request, state, timeout)
			if err != nil {
				return err
			}
			text := "unknown"
			if answer.ServiceStatus != nil {
				text = strings.ToLower(toolrt.Str(answer.ServiceStatus))
			}
			if !serviceStatus.MatchString(text) {
				text = "unknown"
			}
			// Не сохраняем сообщения сервиса: они могут включать подписанные URL.
			state.Set("service_status", text)
			switch answer.Status {
			case "failed":
				state.Set("status", "failed")
				if err := writeState(workDir, state); err != nil {
					return err
				}
				result = state
				return nil
			case "completed":
				if answer.Outputs != nil && toolrt.Equal(toolrt.NewInt(int64(len(answer.Outputs))), request.Value("outputs")) {
					fetcher, ok := service.(mediaapi.Fetcher)
					if !ok {
						return unsupported(request.Value("provider"))
					}
					if err := receive(ctx, fetcher, workDir, request, state, answer.Outputs); err != nil {
						return err
					}
					result = state
					return nil
				}
				state.Set("status", "outputs_pending")
			default:
				state.Set("status", answer.Status)
			}
			if err := writeState(workDir, state); err != nil {
				return err
			}
			if monotonic() >= deadline {
				result = state
				return nil
			}
			if err := sleep(ctx, math.Min(interval, math.Max(0, deadline-monotonic()))); err != nil {
				return err
			}
		}
	})
	return result, err
}

// poll — вызов Poll адаптера; любая ошибка или неизвестный статус — «ID сохранён, повторите
// resume» без подробностей сервиса. Отмена задания возвращается как есть.
func poll(ctx context.Context, service mediaadapters.Adapter, directory string, request, state *toolrt.Dict, timeout float64) (mediaapi.PollResult, error) {
	poller, ok := service.(mediaapi.Poller)
	if !ok {
		return mediaapi.PollResult{}, valueError(textPollFailed)
	}
	answer, err := poller.Poll(ctx, directory, request, state.Clone(), mediaapi.Seconds(timeout))
	if err != nil && ctx.Err() != nil {
		return mediaapi.PollResult{}, ctx.Err()
	}
	if err != nil || !pollStatuses[answer.Status] {
		return mediaapi.PollResult{}, valueError(textPollFailed)
	}
	return answer, nil
}

// unknownAttempt — попытка с неизвестным исходом без ID и без скачанных файлов.
func unknownAttempt(directory string) (*toolrt.Dict, *toolrt.Dict, error) {
	request, state, err := LoadAttempt(directory, false)
	if err != nil {
		return nil, nil, err
	}
	status, err := item(state, "status")
	if err != nil {
		return nil, nil, err
	}
	unknown := toolrt.Equal(status, "submitting") || toolrt.Equal(status, "submission_unknown")
	if toolrt.Truthy(state.Value("generation_id")) || !unknown || toolrt.Truthy(state.Value("downloads")) {
		return nil, nil, valueError(textNotUnknown)
	}
	return request, state, nil
}

// resolveUnknown записывает решение пользователя с временем UTC в unknown_outcomes.
// По истории видно, что исход установил пользователь, а не сервис.
func resolveUnknown(state *toolrt.Dict, resolution string) error {
	entry := toolrt.NewDict()
	entry.Set("resolution", resolution)
	entry.Set("at", utcNow().Format("2006-01-02T15:04:05Z"))
	if !state.Has("unknown_outcomes") {
		state.Set("unknown_outcomes", []any{})
	}
	list, ok := state.Value("unknown_outcomes").([]any)
	if !ok {
		return toolrt.Raise(toolrt.AttributeError, "ожидается список, получено: %s", toolrt.TypeName(state.Value("unknown_outcomes")))
	}
	state.Set("unknown_outcomes", append(list, entry))
	return nil
}

// NotCreated — пользователь не нашёл генерацию в истории сервиса; попытка снова
// готова к одной отправке после нового согласия.
func NotCreated(root, directory string) (*toolrt.Dict, error) {
	workDir, err := WorkPath(root, directory)
	if err != nil {
		return nil, err
	}
	var result *toolrt.Dict
	err = withLock(workDir, func() error {
		_, state, err := unknownAttempt(workDir)
		if err != nil {
			return err
		}
		state.Set("status", "prepared")
		if err := resolveUnknown(state, "not_created"); err != nil {
			return err
		}
		if err := writeState(workDir, state); err != nil {
			return err
		}
		result = state
		return nil
	})
	return result, err
}

// Attach — оригиналы, скачанные пользователем из истории генераций, становятся результатом
// попытки без новой отправки. Число файлов равно outputs; видео —
// сигнатура MP4, изображение — PNG/JPEG/WebP. Файлы копируются без перекодирования, публикуются
// только все вместе после проверки; существующие не перезаписываются.
func Attach(root, directory string, files []string) (*toolrt.Dict, error) {
	workDir, err := WorkPath(root, directory)
	if err != nil {
		return nil, err
	}
	var result *toolrt.Dict
	err = withLock(workDir, func() error {
		request, state, err := unknownAttempt(workDir)
		if err != nil {
			return err
		}
		downloads, err := publishOriginals(workDir, request, files, false)
		if err != nil {
			return err
		}
		state.Set("status", "downloaded")
		state.Set("downloads", downloads)
		state.Set("manual_result", true)
		if err := resolveUnknown(state, "manual_result"); err != nil {
			return err
		}
		if err := writeState(workDir, state); err != nil {
			return err
		}
		result = state
		return nil
	})
	return result, err
}

// ManualMeta — сведения о видео, созданном вне приложения: источник (обязателен), необязательная
// стоимость с единицей и примечание пользователя. Пустая строка и nil — «не указано».
type ManualMeta struct {
	Source     string
	CostAmount *float64
	CostUnit   string
	Note       string
}

// costUnits — допустимые единицы стоимости ручной генерации: кредиты сервиса, рубли, доллары.
var costUnits = []string{"credits", "RUB", "USD"}

// AttachManual — видео, созданное пользователем вне приложения по пакету ручной генерации
// (requestsnapshot.PrepareManual), становится оригиналом попытки manual_pending. Проверки файла
// те же, что у Attach; в attempt.json пишутся SHA оригинала и manual_generation: источник, имя
// исходного файла, время загрузки UTC, стоимость {amount, unit} или null и примечание или null.
func AttachManual(root, directory, file string, meta ManualMeta) (*toolrt.Dict, error) {
	workDir, err := WorkPath(root, directory)
	if err != nil {
		return nil, err
	}
	source, note := toolrt.Strip(meta.Source), toolrt.Strip(meta.Note)
	if source == "" {
		return nil, valueError(textManualSource)
	}
	var cost any
	if meta.CostAmount != nil {
		if math.IsNaN(*meta.CostAmount) || math.IsInf(*meta.CostAmount, 0) || *meta.CostAmount < 0 {
			return nil, valueError(textManualCost)
		}
		found := false
		for _, unit := range costUnits {
			found = found || unit == meta.CostUnit
		}
		if !found {
			return nil, valueError(textManualCostUnit)
		}
		// Целая стоимость пишется целым числом JSON, дробная — числом с точкой.
		var amount any = *meta.CostAmount
		if *meta.CostAmount == math.Trunc(*meta.CostAmount) && *meta.CostAmount < 1e15 {
			amount = toolrt.NewInt(int64(*meta.CostAmount))
		}
		entry := toolrt.NewDict()
		entry.Set("amount", amount)
		entry.Set("unit", meta.CostUnit)
		cost = entry
	}
	var result *toolrt.Dict
	err = withLock(workDir, func() error {
		request, state, err := LoadAttempt(workDir, false)
		if err != nil {
			return err
		}
		status, err := item(state, "status")
		if err != nil {
			return err
		}
		if !toolrt.Equal(request.Value("mode"), "manual") || !toolrt.Equal(status, "manual_pending") || toolrt.Truthy(state.Value("downloads")) {
			return valueError(textNotManual)
		}
		downloads, err := publishOriginals(workDir, request, []string{file}, true)
		if err != nil {
			return err
		}
		generation := toolrt.NewDict()
		generation.Set("source", source)
		generation.Set("original_name", toolrt.PathName(file))
		generation.Set("attached_at", utcNow().Format("2006-01-02T15:04:05Z"))
		generation.Set("cost", cost)
		if note == "" {
			generation.Set("description", nil)
		} else {
			generation.Set("description", note)
		}
		state.Set("status", "downloaded")
		state.Set("downloads", downloads)
		state.Set("manual_result", true)
		state.Set("manual_generation", generation)
		if err := writeState(workDir, state); err != nil {
			return err
		}
		result = state
		return nil
	})
	return result, err
}

// DetachManual снимает с попытки ручной генерации загруженное видео, чтобы загрузить другое:
// копии оригиналов в папке попытки удаляются, состояние возвращается в manual_pending без
// downloads и manual_generation. Исходный файл пользователя вне попытки не трогается. Только для
// mode=manual с загруженным вручную результатом; принятие и черновики монтажа проверяет вызывающий.
func DetachManual(root, directory string) error {
	workDir, err := WorkPath(root, directory)
	if err != nil {
		return err
	}
	return withLock(workDir, func() error {
		request, state, err := LoadAttempt(workDir, false)
		if err != nil {
			return err
		}
		if !toolrt.Equal(request.Value("mode"), "manual") || !toolrt.Equal(state.Value("status"), "downloaded") || !toolrt.Truthy(state.Value("manual_result")) {
			return valueError(textNotManualResult)
		}
		downloads, _ := state.Value("downloads").([]any)
		for _, raw := range downloads {
			entry, _ := raw.(*toolrt.Dict)
			if entry == nil {
				continue
			}
			name, _ := entry.Value("path").(string)
			// Копия лежит в самой папке попытки (original*.ext): чужие пути не удаляются.
			if name == "" || filepath.Base(name) != name || !strings.HasPrefix(name, "original") {
				return valueError(textNotManualResult)
			}
			if err := os.Remove(filepath.Join(workDir, name)); err != nil && !errors.Is(err, os.ErrNotExist) {
				return err
			}
		}
		state.Set("status", "manual_pending")
		state.Delete("downloads")
		state.Delete("manual_result")
		state.Delete("manual_generation")
		return writeState(workDir, state)
	})
}

// publishOriginals проверяет и публикует файлы результата в папке попытки: число файлов равно
// outputs запроса, видео — сигнатура MP4, изображение — PNG/JPEG/WebP; копии собираются во
// временной папке и публикуются жёсткими ссылками original*.ext без перезаписи. Возвращает записи
// downloads; SHA-256 пишется для изображений и, с videoSHA, для видео.
func publishOriginals(workDir string, request *toolrt.Dict, files []string, videoSHA bool) ([]any, error) {
	outputs, err := item(request, "outputs")
	if err != nil {
		return nil, err
	}
	if !toolrt.Equal(toolrt.NewInt(int64(len(files))), outputs) {
		return nil, valueError("Нужно файлов результата: " + toolrt.Str(outputs) + ", выбрано: " + toolrt.NewInt(int64(len(files))).String() + ".")
	}
	image := toolrt.Equal(request.Value("kind"), "image")
	temporary, err := os.MkdirTemp(workDir, ".manual-result-")
	if err != nil {
		return nil, toolrt.OSErrorFrom(err, workDir)
	}
	defer os.RemoveAll(temporary)
	type staged struct {
		number    int
		raw, name string
	}
	prepared := []staged{}
	for index, source := range files {
		number := index + 1
		name := toolrt.PathName(source)
		if !toolrt.IsFile(source) {
			return nil, valueError("Файл результата не найден: " + name)
		}
		raw := filepath.Join(temporary, toolrt.NewInt(int64(number)).String()+".raw")
		if err := requestsnapshot.CopyFile(source, raw); err != nil {
			return nil, err
		}
		rawSize, err := size(raw)
		if err != nil {
			return nil, err
		}
		if rawSize.Sign() == 0 {
			return nil, valueError("Файл результата пуст: " + name)
		}
		var extension string
		if image {
			extension, err = imageExtension(raw)
		} else {
			extension, err = videoExtension(raw)
		}
		if err != nil {
			return nil, err
		}
		target := "original"
		if len(files) != 1 {
			target = "original-" + twoDigits(number)
		}
		target += extension
		if path := filepath.Join(workDir, target); toolrt.Exists(path) || isSymlink(path) {
			return nil, valueError(textExists)
		}
		prepared = append(prepared, staged{number, raw, target})
	}
	downloads := []any{}
	for _, entry := range prepared {
		rawSize, err := size(entry.raw)
		if err != nil {
			return nil, err
		}
		download := toolrt.NewDict()
		download.Set("number", toolrt.NewInt(int64(entry.number)))
		download.Set("path", entry.name)
		download.Set("bytes", rawSize)
		if image || videoSHA {
			digest, err := requestsnapshot.FileSHA(entry.raw)
			if err != nil {
				return nil, err
			}
			download.Set("sha256", digest)
		}
		if err := link(entry.raw, filepath.Join(workDir, entry.name)); err != nil {
			return nil, err
		}
		downloads = append(downloads, download)
	}
	return downloads, nil
}

// WatchEntry — итог одной попытки watch: путь (ключ JSON) и журнал либо {status, detail}.
type WatchEntry struct {
	Path  string
	State *toolrt.Dict
}

// Watch — одно длинное ожидание
// нескольких попыток. Опрашивает их по очереди (resume без ожидания), report получает строку
// «<папка>: <статус>» только при смене статуса или ошибке попытки. Итог — в порядке завершения;
// по истечении времени незавершённые получают {status, detail}, задания не отменяются.
func Watch(ctx context.Context, root string, directories []string, maxMinutes, interval, timeout float64, report func(string)) ([]WatchEntry, error) {
	if !(1 <= maxMinutes && maxMinutes <= 120) || !(5 <= interval && interval <= 300) {
		return nil, valueError(textWatchLimits)
	}
	// Повтор одной папки в списке схлопывается с сохранением порядка первого появления.
	order := []string{}
	last := map[string]any{}
	for _, directory := range directories {
		path, err := WorkPath(root, directory)
		if err != nil {
			return nil, err
		}
		if _, seen := last[path]; !seen {
			order = append(order, path)
			last[path] = nil
		}
	}
	results := []WatchEntry{}
	deadline := monotonic() + maxMinutes*60
	for len(order) > 0 {
		for _, directory := range append([]string(nil), order...) {
			state, err := resume(ctx, directory, "", 0, 15, timeout)
			if err != nil {
				if !toolrt.Is(err, toolrt.ValueError) && !mediaapi.IsNotSubmitted(err) {
					return results, err
				}
				entry := toolrt.NewDict()
				entry.Set("status", "error")
				entry.Set("detail", err.Error())
				results = append(results, WatchEntry{directory, entry})
				report(toolrt.PathName(directory) + ": " + err.Error())
				order = remove(order, directory)
				continue
			}
			status := state.Value("status")
			if !toolrt.Equal(status, last[directory]) {
				report(toolrt.PathName(directory) + ": " + toolrt.Str(status))
				last[directory] = status
			}
			if text, ok := status.(string); ok && Terminal[text] {
				results = append(results, WatchEntry{directory, state})
				order = remove(order, directory)
			}
		}
		if len(order) > 0 && monotonic() >= deadline {
			for _, directory := range order {
				entry := toolrt.NewDict()
				status := last[directory]
				if !toolrt.Truthy(status) {
					status = "unknown"
				}
				entry.Set("status", status)
				entry.Set("detail", textWatchTimeout)
				results = append(results, WatchEntry{directory, entry})
			}
			break
		}
		if len(order) > 0 {
			if err := sleep(ctx, math.Min(interval, math.Max(0, deadline-monotonic()))); err != nil {
				return results, err
			}
		}
	}
	return results, nil
}

// remove — список без элемента.
func remove(items []string, value string) []string {
	result := items[:0:0]
	for _, item := range items {
		if item != value {
			result = append(result, item)
		}
	}
	return result
}

// Capabilities — объявления моделей провайдера для вида
// медиа {"reports", "problems"}; генерации нет.
func Capabilities(ctx context.Context, provider, kind string, timeout float64) (*toolrt.Dict, error) {
	if kind != "image" && kind != "video" {
		return nil, valueError(textKind)
	}
	service, err := mediaadapters.Lookup(provider)
	if err != nil {
		return nil, err
	}
	reporter, ok := service.(mediaapi.CapabilitiesReporter)
	if !ok {
		return nil, unsupported(provider)
	}
	return reporter.Capabilities(ctx, kind, mediaapi.Seconds(timeout))
}

// uuid7 — UUID версии 7 по RFC 9562: 48 бит времени Unix в миллисекундах, версия, вариант и
// случайные биты.
func uuid7() string {
	var value [16]byte
	_, _ = rand.Read(value[6:])
	milliseconds := uint64(time.Now().UnixMilli())
	for index := 0; index < 6; index++ {
		value[index] = byte(milliseconds >> (8 * (5 - index)))
	}
	value[6] = value[6]&0x0f | 0x70
	value[8] = value[8]&0x3f | 0x80
	text := hex.EncodeToString(value[:])
	return text[0:8] + "-" + text[8:12] + "-" + text[12:16] + "-" + text[16:20] + "-" + text[20:32]
}
