package kling

import (
	"context"
	"errors"
	"io"
	"math"
	"net/http"
	"os"
	"sort"
	"strings"
	"time"

	"songframe-go/internal/providers/kling/mcp"
	"songframe-go/internal/pycompat"
)

// successStatuses и failedStatuses — статусы query_tasks (в нижнем регистре).
var (
	successStatuses = map[string]bool{"completed": true, "partial_completed": true, "succeed": true, "succeeded": true, "success": true}
	failedStatuses  = map[string]bool{"failed": true, "cancelled": true, "canceled": true, "rejected": true, "error": true}
)

// fetchTimeout — таймаут операции сокета при скачивании оригинала (urlopen(timeout=60)).
const fetchTimeout = 60 * time.Second

// argument — значение аргумента MCP: строка как есть, прочее — компактный JSON без NaN.
func argument(value any) (string, error) {
	if text, ok := value.(string); ok {
		return text, nil
	}
	return pycompat.DumpsJSON(value, pycompat.DumpOptions{Compact: true, RejectNaN: true})
}

// slotURL — именованный вход конверта: слот и адрес загруженного файла.
type slotURL struct{ slot, url string }

// envelope — конверт инструмента генерации: модель, промпт первым аргументом, остальные
// аргументы по имени (sorted(items)), rationale и именованные входы по URL. У команд без входов
// поля inputs нет.
func envelope(request *pycompat.Dict, prompt string, inputs []slotURL) (*pycompat.Dict, error) {
	parameters, err := pycompat.GetItem(request, "parameters")
	if err != nil {
		return nil, err
	}
	values, ok := parameters.(*pycompat.Dict)
	if !ok {
		return nil, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'items'", pycompat.TypeName(parameters))
	}
	first := pycompat.NewDict()
	first.Set("name", "prompt")
	first.Set("value", prompt)
	arguments := []any{first}
	names := values.Keys()
	sort.Strings(names)
	for _, name := range names {
		text, err := argument(values.Value(name))
		if err != nil {
			return nil, err
		}
		item := pycompat.NewDict()
		item.Set("name", name)
		item.Set("value", text)
		arguments = append(arguments, item)
	}
	model, err := pycompat.GetItem(request, "model")
	if err != nil {
		return nil, err
	}
	result := pycompat.NewDict()
	result.Set("model", model)
	result.Set("arguments", arguments)
	result.Set("rationale", "")
	if len(inputs) > 0 {
		list := make([]any, len(inputs))
		for index, input := range inputs {
			item := pycompat.NewDict()
			item.Set("name", input.slot)
			item.Set("inputType", "URL")
			item.Set("url", input.url)
			list[index] = item
		}
		result.Set("inputs", list)
	}
	return result, nil
}

// inside — inside(directory, name) общего кода попытки: файл подготовленной попытки внутри её
// папки (после разрешения ссылок); иначе ValueError.
func inside(directory string, name any) (string, error) {
	text, ok := name.(string)
	if !ok {
		return "", pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: 'PosixPath' and '%s'", pycompat.TypeName(name))
	}
	path := pycompat.ResolvePath(pycompat.JoinPath(directory, text))
	if !pycompat.IsRelativeTo(path, pycompat.ResolvePath(directory)) || !pycompat.IsFile(path) {
		return "", valueError("Нет локального файла подготовленной попытки.")
	}
	return path, nil
}

// notSubmittedCause — исключения, которые оригинал переводил в NotSubmitted до вызова генерации:
// (KlingError, OSError, ValueError).
func notSubmittedCause(err error) bool {
	return mcp.IsKlingError(err) || pycompat.IsAny(err, pycompat.OSError, pycompat.ValueError)
}

// Submit — submit(directory, request, state, timeout): загрузка входов и единственный tools/call
// команды генерации. Всё до вызова генерации (нет входа, соединения, сбой initialize или
// загрузки) — NotSubmittedError; isError генерации — RejectedRequestError; HTTP-ошибка, ошибка
// JSON-RPC, таймаут или обрыв после отправки и ответ без generationId — прочая ошибка
// (неизвестный исход), с отладочной записью в DebugFile. Результат — {"generation_id",
// "credits_consumed"?}.
func (a *Adapter) Submit(ctx context.Context, directory string, request, state *pycompat.Dict, timeout time.Duration) (*pycompat.Dict, error) {
	inputs, err := pycompat.GetItem(request, "inputs")
	if err != nil {
		return nil, err
	}
	items, err := pycompat.Iter(inputs)
	if err != nil {
		return nil, err
	}
	for _, item := range items {
		values, err := asDict(item)
		if err != nil {
			return nil, err
		}
		if !pycompat.Equal(values.Value("flag"), "input") || !pycompat.Truthy(values.Value("slot")) {
			return nil, &NotSubmittedError{"Входы запроса передаются только именованными слотами; подготовьте новую попытку."}
		}
	}
	session := a.open(timeout, state.Value("task_trace_id"))
	notSubmitted := func(err error) error {
		if notSubmittedCause(err) {
			return &NotSubmittedError{err.Error() + " Загрузка не завершена, отправка не начиналась."}
		}
		return err
	}
	promptInfo, err := pycompat.GetItem(request, "prompt")
	if err != nil {
		return nil, err
	}
	promptName, err := pycompat.GetItem(promptInfo, "path")
	if err != nil {
		return nil, err
	}
	promptPath, err := inside(directory, promptName)
	if err != nil {
		return nil, notSubmitted(err)
	}
	data, err := os.ReadFile(promptPath)
	if err != nil {
		return nil, notSubmitted(pycompat.OSErrorFrom(err, promptPath))
	}
	prompt, err := pycompat.DecodeUTF8(data)
	if err != nil {
		return nil, notSubmitted(err)
	}
	if _, err := session.Initialize(ctx); err != nil {
		return nil, notSubmitted(err)
	}
	uploaded := []slotURL{}
	for _, item := range items {
		values := item.(*pycompat.Dict)
		slot, err := pycompat.GetItem(values, "slot")
		if err != nil {
			return nil, err
		}
		name, err := pycompat.GetItem(values, "path")
		if err != nil {
			return nil, err
		}
		path, err := inside(directory, name)
		if err != nil {
			return nil, notSubmitted(err)
		}
		url, err := session.Upload(ctx, path, nil)
		if err != nil {
			return nil, notSubmitted(err)
		}
		uploaded = append(uploaded, slotURL{pycompat.Str(slot), url})
	}
	unknown := func(err error) error {
		var status *int
		var text *string
		var transport *mcp.TransportError
		if errors.As(err, &transport) {
			text = &transport.Text
			if transport.Status != 0 {
				status = &transport.Status
			}
		}
		a.Client.Debug("submit", err, status, text)
		return err
	}
	command, err := pycompat.GetItem(request, "command")
	if err != nil {
		return nil, unknown(err)
	}
	commandName, _ := command.(string)
	call, err := envelope(request, prompt, uploaded)
	if err != nil {
		return nil, unknown(err)
	}
	submitTimeout := a.SubmitTimeout
	if submitTimeout <= 0 {
		submitTimeout = mcp.SubmitTimeout
	}
	body, err := session.Call(ctx, commandName, call, submitTimeout, nil)
	switch {
	case err == nil:
	case mcp.IsAuthRequired(err), mcp.IsNotSent(err):
		return nil, &NotSubmittedError{err.Error() + " Отправка не начиналась."}
	case mcp.IsToolError(err):
		// isError — явный ответ сервера без созданного задания.
		return nil, &RejectedRequestError{err.Error()}
	default:
		return nil, unknown(err)
	}
	values, _ := body.(*pycompat.Dict)
	var generation any
	if values != nil {
		generation, _ = pycompat.DictGet(values, "generationId", values.Value("generation_id"))
	}
	generationID, ok := generation.(string)
	if !ok || generationID == "" {
		failure := valueError("ответ без generationId")
		status := 200
		dumped, _ := pycompat.DumpsJSON(body, pycompat.DumpOptions{})
		a.Client.Debug("submit", failure, &status, &dumped)
		return nil, failure
	}
	answer := pycompat.NewDict()
	answer.Set("generation_id", generationID)
	switch credits := values.Value("creditsConsumed").(type) {
	case pycompat.Int:
		if _, err := credits.Float(); err != nil {
			return nil, err
		}
		answer.Set("credits_consumed", credits)
	case float64:
		if !math.IsInf(credits, 0) && !math.IsNaN(credits) {
			answer.Set("credits_consumed", credits)
		}
	}
	return answer, nil
}

// Poll — poll(directory, request, state, timeout): состояние задания state.generation_id через
// query_tasks. Результат — {"service_status", "status"[, "outputs"]}: failed, running,
// outputs_pending, watermark_free_pending или completed с адресами оригиналов. Явный адрес без
// логотипа приоритетен у обоих медиа; видео без него ждёт (обычный url не скачивается), у
// изображения допустим исходный url. Адреса в журнал попытки не попадают — это забота общего кода.
func (a *Adapter) Poll(ctx context.Context, directory string, request, state *pycompat.Dict, timeout time.Duration) (*pycompat.Dict, error) {
	session := a.open(timeout, state.Value("task_trace_id"))
	generationID, err := pycompat.GetItem(state, "generation_id")
	if err != nil {
		return nil, err
	}
	arguments := pycompat.NewDict()
	arguments.Set("generationId", generationID)
	value, err := session.Call(ctx, "query_tasks", arguments, 0, nil)
	if err != nil {
		return nil, err
	}
	return pollAnswer(value, request, generationID)
}

// pollAnswer — разбор ответа query_tasks (часть poll после вызова).
func pollAnswer(value any, request *pycompat.Dict, generationID any) (*pycompat.Dict, error) {
	body, ok := value.(*pycompat.Dict)
	if !ok {
		return nil, valueError("query_tasks вернул неверный ответ.")
	}
	reported, found := body.Get("generationId")
	if !found {
		reported, found = body.Get("generation_id")
		if !found {
			reported = generationID
		}
	}
	if !pycompat.Equal(reported, generationID) {
		return nil, valueError("query_tasks вернул состояние другого задания.")
	}
	status, found := body.Get("status")
	if !found {
		status = "unknown"
	}
	serviceStatus := strings.ToLower(pycompat.Str(status))
	answer := pycompat.NewDict()
	answer.Set("service_status", serviceStatus)
	if failedStatuses[serviceStatus] {
		answer.Set("status", "failed")
		return answer, nil
	}
	if !successStatuses[serviceStatus] {
		answer.Set("status", "running")
		return answer, nil
	}
	kind, err := pycompat.GetItem(request, "kind")
	if err != nil {
		return nil, err
	}
	worksValue, _ := pycompat.DictGet(body, "works", []any{})
	all, err := pycompat.Iter(worksValue)
	if err != nil {
		return nil, err
	}
	works := []*pycompat.Dict{}
	for _, item := range all {
		work, ok := item.(*pycompat.Dict)
		if !ok {
			continue
		}
		workStatus, found := work.Get("status")
		if !found {
			workStatus = "completed"
		}
		contentType, found := work.Get("contentType")
		if !found {
			contentType, found = work.Get("content_type")
			if !found {
				contentType = kind
			}
		}
		if successStatuses[strings.ToLower(pycompat.Str(workStatus))] && pycompat.Equal(contentType, kind) {
			works = append(works, work)
		}
	}
	outputs, err := pycompat.GetItem(request, "outputs")
	if err != nil {
		return nil, err
	}
	if !pycompat.Equal(pycompat.NewInt(int64(len(works))), outputs) {
		answer.Set("status", "outputs_pending")
		return answer, nil
	}
	urls := []any{}
	complete := true
	for _, work := range works {
		url := work.Value("urlWithoutWatermark")
		if !pycompat.Truthy(url) {
			url = work.Value("url_without_watermark")
		}
		if !pycompat.Truthy(url) {
			url = nil
			if pycompat.Equal(kind, "image") {
				url = work.Value("url")
			}
		}
		urls = append(urls, url)
	}
	// all(...) останавливается на первом неподходящем адресе: дальше адреса не разбираются.
	for _, url := range urls {
		text, ok := url.(string)
		if ok {
			scheme, err := mcp.URLScheme(text)
			if err != nil {
				return nil, err
			}
			ok = scheme == "https"
		}
		if !ok {
			complete = false
			break
		}
	}
	if !complete {
		if pycompat.Equal(kind, "video") {
			answer.Set("status", "watermark_free_pending")
		} else {
			answer.Set("status", "outputs_pending")
		}
		return answer, nil
	}
	answer.Set("status", "completed")
	answer.Set("outputs", urls)
	return answer, nil
}

// fetcher — HTTP-клиент скачивания: прокси окружения и перенаправления, как urlopen.
func (a *Adapter) fetcher() *http.Client {
	a.fetchOnce.Do(func() {
		a.fetchClient = &http.Client{Transport: mcp.NewTransport(a.Client.TLSConfig, true)}
	})
	return a.fetchClient
}

// Fetch — fetch(url, destination): скачивает полный оригинал по HTTPS в destination (создаётся
// или перезаписывается только после ответа сервера) и сверяет размер с Content-Length.
// Публикацию и защиту от перезаписи результата выполняет общий код. Отличие от оригинала:
// обрыв тела до объявленной длины даёт тот же текст «Загрузка не завершена.», а не
// IncompleteRead http.client.
func (a *Adapter) Fetch(ctx context.Context, url, destination string) error {
	scheme, err := mcp.URLScheme(url)
	if err != nil {
		return err
	}
	if scheme != "https" {
		return valueError("Сервис вернул недопустимый адрес результата.")
	}
	request, err := http.NewRequestWithContext(mcp.WithSocketTimeout(ctx, fetchTimeout), "GET", url, nil)
	if err != nil {
		return valueError(err.Error())
	}
	// urlopen посылал Accept-Encoding: identity; сжатие сломало бы сверку с Content-Length.
	request.Header.Set("Accept-Encoding", "identity")
	request.Header.Set("User-Agent", "Python-urllib/3.12")
	response, err := a.fetcher().Do(request)
	if err != nil {
		return pycompat.Raise(pycompat.OSError, "<urlopen error %s>", err.Error())
	}
	defer response.Body.Close()
	if response.StatusCode < 200 || response.StatusCode >= 300 {
		return pycompat.Raise(pycompat.OSError, "HTTP Error %d: %s", response.StatusCode, http.StatusText(response.StatusCode))
	}
	target, err := os.Create(destination)
	if err != nil {
		return pycompat.OSErrorFrom(err, destination)
	}
	written, copyErr := io.Copy(target, response.Body)
	closeErr := target.Close()
	if errors.Is(copyErr, io.ErrUnexpectedEOF) || response.ContentLength >= 0 && written != response.ContentLength {
		return valueError("Загрузка не завершена.")
	}
	if copyErr != nil {
		return pycompat.Raise(pycompat.OSError, "%s", copyErr.Error())
	}
	if closeErr != nil {
		return pycompat.OSErrorFrom(closeErr, destination)
	}
	return nil
}
