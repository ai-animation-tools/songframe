// Package mediarequest — перенос tools/media_request оригинала: общий жизненный цикл одной
// попытки генерации у выбранного провайдера (возможности, подготовка, единственная отправка,
// получение оригиналов, ручной результат при неизвестном исходе) и CLI media_request.
//
// Сервис здесь не известен: команды, разбор ответов и загрузку выполняет адаптер из
// internal/mediaadapters (возможности — интерфейсы internal/mediaapi). Пакет ведёт состояние
// attempt.json, файловый замок, SHA, единственную отправку и сохранность оригиналов. Файлы
// попытки, статусы, тексты ошибок и вывод CLI совпадают с оригиналом (эталоны
// testdata/golden/media-request).
//
// Отличия устройства от оригинала:
//   - проект (ROOT оригинала) передаётся параметром root, а не определяется при импорте;
//   - вызовы сервиса получают context.Context: отмена задания прерывает опрос и ожидание. Отмена
//     во время отправки оставляет попытку submitting (как обрыв процесса в оригинале), а не
//     submission_unknown; обе формы одинаково считаются неизвестным исходом;
//   - адаптер без Submit отклоняется до записи submitting (в оригинале AttributeError внутри
//     отправки превращался в submission_unknown без обращения к сервису).
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

	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/requestsnapshot"
)

// Статусы. pending — ожидание продолжения того же задания; pollStatuses — допустимые ответы
// poll адаптера (completed общий код превращает в получение оригиналов); Terminal — итоговые.
var (
	pending      = map[string]bool{"running": true, "outputs_pending": true, "watermark_free_pending": true}
	pollStatuses = map[string]bool{"running": true, "outputs_pending": true, "watermark_free_pending": true, "failed": true, "completed": true}
	// Terminal — статусы, после которых watch перестаёт ждать попытку.
	Terminal = map[string]bool{"downloaded": true, "failed": true}
)

// Тексты отказов оригинала (ValueError): CLI печатает их в stderr как есть.
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
)

func valueError(message string) error { return pycompat.New(pycompat.ValueError, message) }

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
// временных папок выполняются, как finally при KeyboardInterrupt оригинала.
var hooks struct {
	journal func(state *pycompat.Dict)
	link    func(destination string)
}

// writeState — atomic_json(directory / "attempt.json", state).
func writeState(directory string, state *pycompat.Dict) error {
	if hooks.journal != nil {
		hooks.journal(state)
	}
	return requestsnapshot.AtomicJSON(filepath.Join(directory, "attempt.json"), state)
}

// link — os.link(source, destination): публикация без перезаписи (существующая цель — OSError).
func link(source, destination string) error {
	if hooks.link != nil && strings.HasPrefix(filepath.Base(destination), "original") {
		hooks.link(destination)
	}
	if err := os.Link(source, destination); err != nil {
		return pycompat.OSErrorFrom(err, source)
	}
	return nil
}

// isSymlink — Path.is_symlink().
func isSymlink(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode()&os.ModeSymlink != 0
}

// tempDir — tempfile.gettempdir().
func tempDir() string { return os.TempDir() }

// WorkPath — work_path(value): проверенная рабочая папка попытки. Попытка — внутри
// plan/batches, plan/awaiting (отложенная попытка запускается прямо из очереди),
// plan/reference-images (архив попыток генерации референса) или временной папки ОС; сами
// корни этих папок проекта, исходники и аниматик попыткой быть не могут.
//
// Отличие от 634fd94: оригинал не допускал plan/reference-images, и платная генерация
// референса отказывала на подготовке; архив референса — его штатное место (этап 45).
func WorkPath(root, value string) (string, error) {
	path := pycompat.ResolvePath(value)
	allowed := []string{
		pycompat.ResolvePath(pycompat.JoinPath(root, "plan/batches")),
		pycompat.ResolvePath(pycompat.JoinPath(root, "plan/awaiting")),
		pycompat.ResolvePath(pycompat.JoinPath(root, "plan/reference-images")),
	}
	inside, isRoot := false, false
	for _, base := range allowed {
		inside = inside || pycompat.IsRelativeTo(path, base)
		isRoot = isRoot || path == base
	}
	inside = inside || pycompat.IsRelativeTo(path, pycompat.ResolvePath(tempDir()))
	if isRoot || !inside {
		return "", valueError(textWorkDir)
	}
	for _, name := range []string{"assets", "source", "plan/animatic"} {
		if pycompat.IsRelativeTo(path, pycompat.ResolvePath(pycompat.JoinPath(root, name))) {
			return "", valueError(textWorkDirProtected)
		}
	}
	return path, nil
}

// insideFile — inside(directory, name): файл попытки внутри её папки после разрешения ссылок.
func insideFile(directory string, name any) (string, error) {
	text, ok := name.(string)
	if !ok {
		return "", pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: 'PosixPath' and '%s'", pycompat.TypeName(name))
	}
	path := pycompat.ResolvePath(pycompat.JoinPath(directory, text))
	if !pycompat.IsRelativeTo(path, pycompat.ResolvePath(directory)) || !pycompat.IsFile(path) {
		return "", valueError(textNoLocalFile)
	}
	return path, nil
}

// withLock — locked(directory): неблокирующий замок файла .lock попытки на время действия.
// Занятая попытка отклоняется сразу (повторная отправка не ждёт первую).
func withLock(directory string, action func() error) error {
	path := filepath.Join(directory, ".lock")
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o666)
	if err != nil {
		return pycompat.OSErrorFrom(err, path)
	}
	defer file.Close()
	if err := lockFile(file); err != nil {
		if errors.Is(err, errBusy) {
			return valueError(textBusy)
		}
		return pycompat.OSErrorFrom(err, path)
	}
	defer unlockFile(file)
	return action()
}

// errBusy — замок держит другой процесс (EAGAIN/EACCES/EDEADLK оригинала).
var errBusy = errors.New("занято")

// readJSON — json.loads(path.read_text()).
func readJSON(path string) (any, error) { return pycompat.LoadJSONFile(path) }

// item — container[key] моделью Python (KeyError/TypeError на чужой форме).
func item(container any, key string) (any, error) { return pycompat.Item(container, key) }

// get — container.get(key) (AttributeError у не-словаря).
func get(container any, key string) (any, error) { return pycompat.DictGet(container, key, nil) }

// LoadAttempt — load_attempt(directory, verify_inputs): замороженный запрос и журнал попытки.
// Запрос должен указывать провайдера подключённого адаптера и совпадать с request_sha256
// журнала; с verifyInputs сверяются хеши промпта и входов.
func LoadAttempt(directory string, verifyInputs bool) (*pycompat.Dict, *pycompat.Dict, error) {
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
	if !mediaadapters.Known(provider) {
		return nil, nil, valueError(textNoProvider)
	}
	request := requestValue.(*pycompat.Dict)
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
	if !pycompat.Equal(digest, saved) {
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
		entries, err := pycompat.Iter(inputs)
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
			if !pycompat.Equal(actual, expected) {
				return nil, nil, valueError(textInputChanged)
			}
		}
	}
	return request, stateValue.(*pycompat.Dict), nil
}

// adapterOf — media_adapters.adapter(request["provider"]).
func adapterOf(request *pycompat.Dict) (mediaadapters.Adapter, error) {
	provider, err := item(request, "provider")
	if err != nil {
		return nil, err
	}
	return mediaadapters.Lookup(provider)
}

// Prepare — prepare(request, directory): замораживает спецификацию в новой папке попытки.
// Общую форму проверяет requestsnapshot, ограничения сервиса и промпта — адаптер провайдера
// спецификации до создания папки; FROZEN_FIELDS адаптера входят в запрос и SHA, предупреждения
// о промпте — в warnings результата. Сервис не вызывается.
func Prepare(root, request, directory string) (*pycompat.Dict, error) {
	value, err := readJSON(request)
	if err != nil {
		return nil, err
	}
	if err := requestsnapshot.ValidateSpec(value); err != nil {
		return nil, err
	}
	spec := value.(*pycompat.Dict)
	service, err := mediaadapters.Lookup(spec.Value("provider"))
	if err != nil {
		return nil, err
	}
	if validator, ok := service.(mediaapi.SpecValidator); ok {
		if err := validator.ValidateSpec(spec); err != nil {
			return nil, err
		}
	}
	promptPath := pycompat.JoinPath(filepath.Dir(pycompat.ResolvePath(request)), spec.Value("prompt_file").(string))
	data, err := os.ReadFile(promptPath)
	if err != nil {
		return nil, pycompat.OSErrorFrom(err, promptPath)
	}
	prompt, err := pycompat.DecodeUTF8(data)
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
	var frozen *pycompat.Dict
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

// Status — status(directory): только локальный журнал попытки, без обращения к сервису.
func Status(root, directory string) (*pycompat.Dict, error) {
	workDir, err := WorkPath(root, directory)
	if err != nil {
		return nil, err
	}
	_, state, err := LoadAttempt(workDir, false)
	return state, err
}

// identifier — identifier(value): ID задания печатаемой ASCII-строкой до 2048 символов, без
// ведущего «-» и схемы URL (подписанный адрес вместо ID не сохраняется).
func identifier(value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", valueError(textBadID)
	}
	length := pycompat.Len(text)
	if length < 1 || length > 2048 || strings.HasPrefix(text, "-") || strings.Contains(text, "://") {
		return "", valueError(textBadID)
	}
	for _, r := range pycompat.Runes(text) {
		if r < 33 || r > 126 {
			return "", valueError(textBadID)
		}
	}
	return text, nil
}

// finite — math.isfinite(value) and value > 0 для таймаута.
func positive(value float64) bool { return !math.IsNaN(value) && !math.IsInf(value, 0) && value > 0 }

// Submit — submit(directory, confirmation, timeout): единственная отправка подготовленной
// попытки по подтверждению её SHA. Перед вызовом адаптера сверяются хеши промпта и входов и
// записывается submitting; generation_id сохраняется сразу после ответа. Повтор запрещён,
// включая submitting и submission_unknown. Явный отказ и «отправка не начиналась» возвращают
// попытку в prepared (отказ — с last_rejection); прочие сбои — submission_unknown.
func Submit(ctx context.Context, root, directory, confirmation string, timeout float64) (*pycompat.Dict, error) {
	workDir, err := WorkPath(root, directory)
	if err != nil {
		return nil, err
	}
	if !positive(timeout) {
		return nil, valueError(textTimeout)
	}
	var result *pycompat.Dict
	err = withLock(workDir, func() error {
		request, state, err := LoadAttempt(workDir, true)
		if err != nil {
			return err
		}
		status, err := item(state, "status")
		if err != nil {
			return err
		}
		if !pycompat.Equal(status, "prepared") || pycompat.Truthy(state.Value("generation_id")) {
			return valueError(textAlreadySent)
		}
		if !pycompat.Equal(confirmation, state.Value("request_sha256")) {
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
		case pycompat.Int:
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

// unsupported — отказ provider_function: у адаптера нет нужной возможности.
func unsupported(provider any) error {
	return valueError("Провайдер " + pycompat.Repr(provider) + " не поддерживает это действие.")
}

// publish — publish(service, output, destination): адаптер пишет байты результата во временный
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
		return pycompat.OSErrorFrom(err, temporary)
	}
	if info.Size() == 0 {
		return valueError(textEmptyResult)
	}
	if err := os.Link(temporary, destination); err != nil {
		return pycompat.OSErrorFrom(err, temporary)
	}
	return nil
}

// header — первые 12 байт файла.
func header(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, pycompat.OSErrorFrom(err, path)
	}
	defer file.Close()
	data := make([]byte, 12)
	count, _ := file.Read(data)
	return data[:count], nil
}

// imageExtension — image_extension(path): контейнер оригинала по сигнатуре, а не по адресу.
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

// videoExtension — video_extension(path): MP4 по ftyp.
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

// size — Path.stat().st_size как int Python.
func size(path string) (pycompat.Int, error) {
	info, err := os.Stat(path)
	if err != nil {
		return pycompat.Int{}, pycompat.OSErrorFrom(err, path)
	}
	return pycompat.NewInt(info.Size()), nil
}

// verifySavedImage — verify_saved_image: сохранённый оригинал без переименования и перекодирования.
func verifySavedImage(directory string, entry *pycompat.Dict) error {
	name, err := item(entry, "path")
	if err != nil {
		return err
	}
	if text, ok := name.(string); ok && isSymlink(pycompat.JoinPath(directory, text)) {
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
	suffix := strings.ToLower(pycompat.PathSuffix(name.(string)))
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
	if !pycompat.Equal(actualSize, bytesValue) {
		return valueError(textResultChanged)
	}
	if expected := entry.Value("sha256"); pycompat.Truthy(expected) {
		digest, err := requestsnapshot.FileSHA(target)
		if err != nil {
			return err
		}
		if !pycompat.Equal(digest, expected) {
			return valueError(textResultChanged)
		}
	}
	return nil
}

// verifyDownload — verify_download: зарегистрированный результат на месте и не изменился.
func verifyDownload(directory string, request *pycompat.Dict, value any) error {
	entry, ok := value.(*pycompat.Dict)
	if !ok {
		return pycompat.Raise(pycompat.TypeError, "'%s' object is not subscriptable", pycompat.TypeName(value))
	}
	if pycompat.Equal(request.Value("kind"), "image") {
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
	if !pycompat.Equal(actualSize, expected) {
		return valueError(textResultChanged)
	}
	return nil
}

// receiveImage — receive_image: сначала получает исходные байты, затем фиксирует намерение
// (номер, путь, размер, SHA) и публикует оригинал. После обрыва между публикацией и журналом
// принимается только тот же оригинал; чужой существующий файл не становится результатом.
func receiveImage(ctx context.Context, fetcher mediaapi.Fetcher, output, directory, stem string, number int, state *pycompat.Dict) (*pycompat.Dict, error) {
	numberValue := pycompat.NewInt(int64(number))
	if pendingDownload, ok := state.Value("pending_download").(*pycompat.Dict); ok && pendingDownload.Len() > 0 {
		names := map[string]bool{}
		for _, extension := range []string{".png", ".jpg", ".jpeg", ".webp"} {
			names[stem+extension] = true
		}
		path, isString := pendingDownload.Value("path").(string)
		if pycompat.Equal(pendingDownload.Value("number"), numberValue) && isString && names[path] {
			target := pycompat.JoinPath(directory, path)
			if pycompat.Exists(target) || isSymlink(target) {
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
		return nil, pycompat.OSErrorFrom(err, directory)
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
	if pycompat.Exists(target) || isSymlink(target) {
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
	proof := pycompat.NewDict()
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

// receiveVideo — receive_video: намерение записывается до скачивания; если процесс оборвался
// после публикации файла, повтор принимает этот файл.
func receiveVideo(ctx context.Context, fetcher mediaapi.Fetcher, output, directory, name string, number int, state *pycompat.Dict) (*pycompat.Dict, error) {
	intent := pycompat.NewDict()
	intent.Set("number", pycompat.NewInt(int64(number)))
	intent.Set("path", name)
	target := filepath.Join(directory, name)
	if pycompat.Exists(target) {
		info, err := os.Stat(target)
		if !pycompat.Equal(state.Value("pending_download"), intent) || isSymlink(target) || err != nil || info.Size() == 0 {
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
	result := pycompat.NewDict()
	result.Set("number", pycompat.NewInt(int64(number)))
	result.Set("path", name)
	result.Set("bytes", targetSize)
	return result, nil
}

// receive — receive: сохраняет все результаты по порядку; зарегистрированные повторно не
// скачиваются. Итог — downloaded.
func receive(ctx context.Context, fetcher mediaapi.Fetcher, directory string, request, state *pycompat.Dict, outputs []string) error {
	state.Set("status", "downloading")
	if err := writeState(directory, state); err != nil {
		return err
	}
	for index, output := range outputs {
		number := index + 1
		downloads, err := pycompat.Iter(state.Value("downloads"))
		if err != nil {
			return err
		}
		var existing any
		for _, entry := range downloads {
			value, err := item(entry, "number")
			if err != nil {
				return err
			}
			if pycompat.Equal(value, pycompat.NewInt(int64(number))) {
				existing = entry
				break
			}
		}
		if pycompat.Truthy(existing) {
			if err := verifyDownload(directory, request, existing); err != nil {
				return err
			}
			continue
		}
		stem := "original"
		if len(outputs) != 1 {
			stem = "original-" + twoDigits(number)
		}
		var original *pycompat.Dict
		if pycompat.Equal(request.Value("kind"), "image") {
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

// twoDigits — f"{number:02}".
func twoDigits(number int) string {
	text := pycompat.NewInt(int64(number)).String()
	if len(text) < 2 {
		return "0" + text
	}
	return text
}

// serviceStatus — допустимая запись статуса сервиса: только строчные латинские буквы и «_».
var serviceStatus = regexp.MustCompile(`^[a-z_]{1,40}$`)

// Resume — resume(directory, generation_id, wait_seconds, interval, timeout): опрос только
// сохранённого ID (один раз либо в пределах waitSeconds с шагом interval) и получение готовых
// оригиналов. generationID привязывает известный ID неизвестной отправки. Ручной результат
// продолжается без ID и без обращения к сервису.
func Resume(ctx context.Context, root, directory, generationID string, waitSeconds, interval, timeout float64) (*pycompat.Dict, error) {
	workDir, err := WorkPath(root, directory)
	if err != nil {
		return nil, err
	}
	return resume(ctx, workDir, generationID, waitSeconds, interval, timeout)
}

func resume(ctx context.Context, workDir, generationID string, waitSeconds, interval, timeout float64) (*pycompat.Dict, error) {
	if !positive(timeout) {
		return nil, valueError(textTimeout)
	}
	if !(0 <= waitSeconds && waitSeconds <= 60) || !(1 <= interval && interval <= 60) {
		return nil, valueError(textWaitLimits)
	}
	var result *pycompat.Dict
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
			if saved != nil && !pycompat.Equal(saved, id) {
				return valueError(textOtherID)
			}
			if !pycompat.Truthy(saved) {
				status, err := item(state, "status")
				if err != nil {
					return err
				}
				if !pycompat.Equal(status, "submitting") && !pycompat.Equal(status, "submission_unknown") {
					return valueError(textManualID)
				}
			}
			state.Set("generation_id", id)
			state.Set("status", "submitted")
			if err := writeState(workDir, state); err != nil {
				return err
			}
		}
		if !pycompat.Truthy(state.Value("generation_id")) {
			manual := false
			if pycompat.Truthy(state.Value("manual_result")) {
				status, err := item(state, "status")
				if err != nil {
					return err
				}
				manual = pycompat.Equal(status, "downloaded")
			}
			if !manual {
				return valueError(textNoID)
			}
		}
		status, err := item(state, "status")
		if err != nil {
			return err
		}
		if pycompat.Equal(status, "downloaded") {
			downloads, err := pycompat.Iter(state.Value("downloads"))
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
		if pycompat.Equal(status, "failed") {
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
				text = strings.ToLower(pycompat.Str(answer.ServiceStatus))
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
				if answer.Outputs != nil && pycompat.Equal(pycompat.NewInt(int64(len(answer.Outputs))), request.Value("outputs")) {
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
func poll(ctx context.Context, service mediaadapters.Adapter, directory string, request, state *pycompat.Dict, timeout float64) (mediaapi.PollResult, error) {
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

// unknownAttempt — unknown_attempt: попытка с неизвестным исходом без ID и без скачанных файлов.
func unknownAttempt(directory string) (*pycompat.Dict, *pycompat.Dict, error) {
	request, state, err := LoadAttempt(directory, false)
	if err != nil {
		return nil, nil, err
	}
	status, err := item(state, "status")
	if err != nil {
		return nil, nil, err
	}
	unknown := pycompat.Equal(status, "submitting") || pycompat.Equal(status, "submission_unknown")
	if pycompat.Truthy(state.Value("generation_id")) || !unknown || pycompat.Truthy(state.Value("downloads")) {
		return nil, nil, valueError(textNotUnknown)
	}
	return request, state, nil
}

// resolveUnknown — resolve_unknown: решение пользователя с временем UTC в unknown_outcomes.
// По истории видно, что исход установил пользователь, а не сервис.
func resolveUnknown(state *pycompat.Dict, resolution string) error {
	entry := pycompat.NewDict()
	entry.Set("resolution", resolution)
	entry.Set("at", utcNow().Format("2006-01-02T15:04:05Z"))
	if !state.Has("unknown_outcomes") {
		state.Set("unknown_outcomes", []any{})
	}
	list, ok := state.Value("unknown_outcomes").([]any)
	if !ok {
		return pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'append'", pycompat.TypeName(state.Value("unknown_outcomes")))
	}
	state.Set("unknown_outcomes", append(list, entry))
	return nil
}

// NotCreated — not_created: пользователь не нашёл генерацию в истории сервиса; попытка снова
// готова к одной отправке после нового согласия.
func NotCreated(root, directory string) (*pycompat.Dict, error) {
	workDir, err := WorkPath(root, directory)
	if err != nil {
		return nil, err
	}
	var result *pycompat.Dict
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

// Attach — attach(directory, files): оригиналы, скачанные пользователем из истории генераций,
// становятся результатом попытки без новой отправки. Число файлов равно outputs; видео —
// сигнатура MP4, изображение — PNG/JPEG/WebP. Файлы копируются без перекодирования, публикуются
// только все вместе после проверки; существующие не перезаписываются.
func Attach(root, directory string, files []string) (*pycompat.Dict, error) {
	workDir, err := WorkPath(root, directory)
	if err != nil {
		return nil, err
	}
	var result *pycompat.Dict
	err = withLock(workDir, func() error {
		request, state, err := unknownAttempt(workDir)
		if err != nil {
			return err
		}
		outputs, err := item(request, "outputs")
		if err != nil {
			return err
		}
		if !pycompat.Equal(pycompat.NewInt(int64(len(files))), outputs) {
			return valueError("Нужно файлов результата: " + pycompat.Str(outputs) + ", выбрано: " + pycompat.NewInt(int64(len(files))).String() + ".")
		}
		image := pycompat.Equal(request.Value("kind"), "image")
		temporary, err := os.MkdirTemp(workDir, ".manual-result-")
		if err != nil {
			return pycompat.OSErrorFrom(err, workDir)
		}
		defer os.RemoveAll(temporary)
		type staged struct {
			number    int
			raw, name string
		}
		prepared := []staged{}
		for index, source := range files {
			number := index + 1
			name := pycompat.PathName(source)
			if !pycompat.IsFile(source) {
				return valueError("Файл результата не найден: " + name)
			}
			raw := filepath.Join(temporary, pycompat.NewInt(int64(number)).String()+".raw")
			if err := requestsnapshot.CopyFile(source, raw); err != nil {
				return err
			}
			rawSize, err := size(raw)
			if err != nil {
				return err
			}
			if rawSize.Sign() == 0 {
				return valueError("Файл результата пуст: " + name)
			}
			var extension string
			if image {
				extension, err = imageExtension(raw)
			} else {
				extension, err = videoExtension(raw)
			}
			if err != nil {
				return err
			}
			target := "original"
			if len(files) != 1 {
				target = "original-" + twoDigits(number)
			}
			target += extension
			if path := filepath.Join(workDir, target); pycompat.Exists(path) || isSymlink(path) {
				return valueError(textExists)
			}
			prepared = append(prepared, staged{number, raw, target})
		}
		downloads := []any{}
		for _, entry := range prepared {
			rawSize, err := size(entry.raw)
			if err != nil {
				return err
			}
			download := pycompat.NewDict()
			download.Set("number", pycompat.NewInt(int64(entry.number)))
			download.Set("path", entry.name)
			download.Set("bytes", rawSize)
			if image {
				digest, err := requestsnapshot.FileSHA(entry.raw)
				if err != nil {
					return err
				}
				download.Set("sha256", digest)
			}
			if err := link(entry.raw, filepath.Join(workDir, entry.name)); err != nil {
				return err
			}
			downloads = append(downloads, download)
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

// WatchEntry — итог одной попытки watch: путь (ключ JSON) и журнал либо {status, detail}.
type WatchEntry struct {
	Path  string
	State *pycompat.Dict
}

// Watch — watch(directories, max_minutes, interval, timeout, report): одно длинное ожидание
// нескольких попыток. Опрашивает их по очереди (resume без ожидания), report получает строку
// «<папка>: <статус>» только при смене статуса или ошибке попытки. Итог — в порядке завершения;
// по истечении времени незавершённые получают {status, detail}, задания не отменяются.
func Watch(ctx context.Context, root string, directories []string, maxMinutes, interval, timeout float64, report func(string)) ([]WatchEntry, error) {
	if !(1 <= maxMinutes && maxMinutes <= 120) || !(5 <= interval && interval <= 300) {
		return nil, valueError(textWatchLimits)
	}
	// Повтор одной папки в списке схлопывается, как ключи dict оригинала.
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
				if !pycompat.Is(err, pycompat.ValueError) && !mediaapi.IsNotSubmitted(err) {
					return results, err
				}
				entry := pycompat.NewDict()
				entry.Set("status", "error")
				entry.Set("detail", err.Error())
				results = append(results, WatchEntry{directory, entry})
				report(pycompat.PathName(directory) + ": " + err.Error())
				order = remove(order, directory)
				continue
			}
			status := state.Value("status")
			if !pycompat.Equal(status, last[directory]) {
				report(pycompat.PathName(directory) + ": " + pycompat.Str(status))
				last[directory] = status
			}
			if text, ok := status.(string); ok && Terminal[text] {
				results = append(results, WatchEntry{directory, state})
				order = remove(order, directory)
			}
		}
		if len(order) > 0 && monotonic() >= deadline {
			for _, directory := range order {
				entry := pycompat.NewDict()
				status := last[directory]
				if !pycompat.Truthy(status) {
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

// Capabilities — capabilities(provider, kind, timeout): объявления моделей провайдера для вида
// медиа {"reports", "problems"}; генерации нет.
func Capabilities(ctx context.Context, provider, kind string, timeout float64) (*pycompat.Dict, error) {
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
// случайные биты (uuid7() из tools/common.py).
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
