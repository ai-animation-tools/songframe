// Package mediatest — тестовый провайдер генерации `test` без сети и платных запросов: перенос
// tools/testing/fake_media_request.py оригинала. Общая логика платной попытки (media_request,
// cost_check, shot_workflow, производство) тестируется на нём, поэтому удаление реального
// провайдера не ломает общие тесты.
//
// Поведение задаёт JSON-файл <Dir>/service.json, читаемый при каждом вызове (его можно менять
// между шагами), каждый вызов дописывается строкой JSON в <Dir>/calls.jsonl — тот же формат, что
// у Python-адаптера, поэтому эталоны оригинала сверяются и по журналу вызовов. Поля конфигурации —
// README tools/testing оригинала: reports, problems, capabilities, submit, poll, results,
// balance, pricing. Дополнения для внесения сбоев (их же понимает адаптер съёмки эталонов):
//   - fetch_errors — номера вызовов fetch (по журналу, с 1), которые после записи в журнал
//     завершаются OSError (обрыв загрузки);
//   - task_trace_id — адаптер объявляет TASK_TRACE_ID;
//   - login, auth_status — ответы входа у варианта WithAuth.
//
// Пакет не тестовый (не _test.go), чтобы им пользовались тесты разных пакетов; в таблицу
// адаптеров он попадает только через Register.
package mediatest

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"time"

	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/requestsnapshot"
)

// ID — id тестового провайдера.
const ID = "test"

// BuiltinVideo — встроенный результат видео: минимальный файл с сигнатурой MP4.
var BuiltinVideo = []byte("\x00\x00\x00\x18ftypmp42\x00\x00\x00\x00mp42isom")

// BuiltinPNG — встроенный результат изображения: PNG 1×1 (байты builtin_png() оригинала).
var BuiltinPNG = []byte("\x89PNG\r\n\x1a\n\x00\x00\x00\rIHDR\x00\x00\x00\x01\x00\x00\x00\x01\x08\x02\x00\x00\x00\x90wS\xde" +
	"\x00\x00\x00\x0cIDATx\x9cchhh\x00\x00\x03\x04\x01\x81K\xd3\xd2\x10\x00\x00\x00\x00IEND\xaeB`\x82")

// defaultReports — DEFAULT_REPORTS оригинала в порядке ключей Python.
const defaultReports = `{
 "image": [
  {"command": "text_to_image", "models": {"test-image": {"arguments": {"aspect_ratio": {"default": "16:9", "allowed": ["16:9", "9:16", "1:1"]}}, "slots": {}, "limits": {}}}},
  {"command": "image_to_image", "models": {"test-image": {"arguments": {"aspect_ratio": {"default": "16:9", "allowed": ["16:9", "9:16", "1:1"]}}, "slots": {"image_1": {"required": true}, "image_2": {"required": false}}, "limits": {}}}}
 ],
 "video": [
  {"command": "text_to_video", "models": {"test-video": {"arguments": {"duration": {"default": "5", "allowed": ["3", "4", "5", "6", "8", "10"]}, "resolution": {"default": "1080p", "allowed": ["720p", "1080p"]}, "aspect_ratio": {"default": "16:9", "allowed": ["16:9", "9:16", "1:1"]}}, "slots": {}, "limits": {}}}},
  {"command": "image_to_video", "models": {"test-video": {"arguments": {"duration": {"default": "5", "allowed": ["3", "4", "5", "6", "8", "10"]}, "resolution": {"default": "1080p", "allowed": ["720p", "1080p"]}, "aspect_ratio": {"default": "16:9", "allowed": ["16:9", "9:16", "1:1"]}}, "slots": {"first_image": {"required": true}, "tail_image": {"required": false}}, "limits": {}}}}
 ]
}`

// Service — тестовый сервис одного теста: папка конфигурации и журнала. Методы — возможности
// адаптера из internal/mediaapi (без входа; вход — у WithAuth).
type Service struct {
	// Dir — папка service.json, calls.jsonl, файлов результатов и таблицы цен по умолчанию.
	Dir string
}

// WithAuth — тестовый сервис с функциями входа login и auth_status (ответы из конфигурации).
type WithAuth struct{ *Service }

// New создаёт сервис в dir с начальной конфигурацией config (nil — пустая).
func New(dir string, config *pycompat.Dict) (*Service, error) {
	if config == nil {
		config = pycompat.NewDict()
	}
	if err := os.MkdirAll(dir, 0o777); err != nil {
		return nil, err
	}
	service := &Service{Dir: dir}
	return service, service.write(config)
}

// Register подключает сервис в таблицу адаптеров под id test; возвращает отмену регистрации.
func (s *Service) Register() func() { return mediaadapters.Register(ID, s) }

func (s *Service) configPath() string { return filepath.Join(s.Dir, "service.json") }

func (s *Service) write(config *pycompat.Dict) error {
	text, err := pycompat.DumpsJSON(config, pycompat.DumpOptions{})
	if err != nil {
		return err
	}
	return os.WriteFile(s.configPath(), []byte(text), 0o666)
}

// Config — текущая конфигурация (отсутствующий файл — пустая).
func (s *Service) Config() *pycompat.Dict {
	value, err := pycompat.LoadJSONFile(s.configPath())
	if dict, ok := value.(*pycompat.Dict); err == nil && ok {
		return dict
	}
	return pycompat.NewDict()
}

// Configure — Service.configure(**values): дополняет конфигурацию полями values.
func (s *Service) Configure(values *pycompat.Dict) error {
	config := s.Config()
	for _, key := range values.Keys() {
		config.Set(key, values.Value(key))
	}
	return s.write(config)
}

// local — пути конфигурации отсчитываются от её папки.
func (s *Service) local(value string) string { return pycompat.JoinPath(s.Dir, value) }

// journal дописывает вызов в calls.jsonl: {"action", …поля} в порядке оригинала.
func (s *Service) journal(action string, pairs ...any) error {
	entry := pycompat.NewDict()
	entry.Set("action", action)
	for index := 0; index+1 < len(pairs); index += 2 {
		entry.Set(pairs[index].(string), pairs[index+1])
	}
	text, err := pycompat.DumpsJSON(entry, pycompat.DumpOptions{})
	if err != nil {
		return err
	}
	file, err := os.OpenFile(filepath.Join(s.Dir, "calls.jsonl"), os.O_WRONLY|os.O_CREATE|os.O_APPEND, 0o666)
	if err != nil {
		return err
	}
	_, err = file.WriteString(text + "\n")
	if closeErr := file.Close(); err == nil {
		err = closeErr
	}
	return err
}

// Calls — записи журнала, по желанию только с данным action ("" — все).
func (s *Service) Calls(action string) []*pycompat.Dict {
	data, err := os.ReadFile(filepath.Join(s.Dir, "calls.jsonl"))
	if err != nil {
		return nil
	}
	entries := []*pycompat.Dict{}
	for _, line := range strings.Split(strings.TrimSuffix(string(data), "\n"), "\n") {
		if line == "" {
			continue
		}
		value, err := pycompat.LoadsJSON(line)
		entry, ok := value.(*pycompat.Dict)
		if err != nil || !ok {
			continue
		}
		if action == "" || entry.Value("action") == action {
			entries = append(entries, entry)
		}
	}
	return entries
}

// failure — исключение адаптера (тип и текст как у Python-сервиса).
func failure(kind, message string) error { return pycompat.New(kind, message) }

// ValidateSpec — тестовый сервис принимает любые команды и параметры общей формы.
func (s *Service) ValidateSpec(*pycompat.Dict) error { return nil }

// ValidatePrompt — промпт не ограничивается.
func (s *Service) ValidatePrompt(string) ([]string, error) { return []string{}, nil }

// FrozenFields — FROZEN_FIELDS пуст.
func (s *Service) FrozenFields() *pycompat.Dict { return pycompat.NewDict() }

// TaskTraceID — TASK_TRACE_ID объявлен, если в конфигурации task_trace_id истинно.
func (s *Service) TaskTraceID() bool { return pycompat.Truthy(s.Config().Value("task_trace_id")) }

// Capabilities — reports/problems вида медиа из конфигурации либо встроенные.
func (s *Service) Capabilities(_ context.Context, kind string, _ time.Duration) (*pycompat.Dict, error) {
	if err := s.journal("capabilities", "kind", kind); err != nil {
		return nil, err
	}
	config := s.Config()
	if pycompat.Equal(config.Value("capabilities"), "error") {
		return nil, failure(pycompat.ValueError, "Тестовый сервис не подтвердил возможности.")
	}
	defaults, _ := pycompat.LoadsJSON(defaultReports)
	reports, err := section(config, "reports", kind, defaults.(*pycompat.Dict).Value(kind))
	if err != nil {
		return nil, err
	}
	problems, err := section(config, "problems", kind, []any{})
	if err != nil {
		return nil, err
	}
	result := pycompat.NewDict()
	result.Set("reports", reports)
	result.Set("problems", problems)
	return result, nil
}

// section — data.get(key, {}).get(kind, fallback).
func section(config *pycompat.Dict, key, kind string, fallback any) (any, error) {
	value, has := config.Get(key)
	if !has {
		return fallback, nil
	}
	dict, ok := value.(*pycompat.Dict)
	if !ok {
		return nil, failure(pycompat.AttributeError, "'"+pycompat.TypeName(value)+"' object has no attribute 'get'")
	}
	if item, has := dict.Get(kind); has {
		return item, nil
	}
	return fallback, nil
}

// Submit — запись отправки в журнал и ответ из конфигурации submit: объект {generation_id?,
// credits_consumed?}, "unknown" — обрыв (неизвестный исход), "not_submitted" — отправка не
// начиналась, {"reject": причина} — явный отказ.
func (s *Service) Submit(_ context.Context, directory string, request, state *pycompat.Dict, _ time.Duration) (mediaapi.SubmitResult, error) {
	promptPath, _ := request.Value("prompt").(*pycompat.Dict).Value("path").(string)
	data, err := os.ReadFile(pycompat.JoinPath(directory, promptPath))
	if err != nil {
		return mediaapi.SubmitResult{}, err
	}
	prompt, err := pycompat.DecodeUTF8(data)
	if err != nil {
		return mediaapi.SubmitResult{}, err
	}
	inputs := []any{}
	items, _ := request.Value("inputs").([]any)
	for _, element := range items {
		item := element.(*pycompat.Dict)
		entry := pycompat.NewDict()
		for _, key := range []string{"flag", "slot", "sha256"} {
			if value, has := item.Get(key); has {
				entry.Set(key, value)
			}
		}
		inputs = append(inputs, entry)
	}
	if err := s.journal("submit", "work_dir", directory, "request_sha256", state.Value("request_sha256"),
		"provider", request.Value("provider"), "kind", request.Value("kind"), "command", request.Value("command"),
		"model", request.Value("model"), "parameters", request.Value("parameters"), "outputs", request.Value("outputs"),
		"inputs", inputs, "prompt", prompt); err != nil {
		return mediaapi.SubmitResult{}, err
	}
	answer, has := s.Config().Get("submit")
	if !has {
		answer = pycompat.NewDict()
	}
	switch {
	case pycompat.Equal(answer, "unknown"):
		return mediaapi.SubmitResult{}, failure("RuntimeError", "Тестовый сервис оборвал отправку.")
	case pycompat.Equal(answer, "not_submitted"):
		return mediaapi.SubmitResult{}, &mediaapi.NotSubmitted{Message: "Тестовый сервис недоступен; отправка не начиналась."}
	}
	dict, ok := answer.(*pycompat.Dict)
	if !ok {
		return mediaapi.SubmitResult{}, failure(pycompat.TypeError, "неверный ответ submit тестового сервиса")
	}
	if reason, has := dict.Get("reject"); has {
		return mediaapi.SubmitResult{}, &mediaapi.RejectedRequest{Message: pycompat.Str(reason)}
	}
	result := mediaapi.SubmitResult{GenerationID: "test-generation-" + pycompat.NewInt(int64(len(s.Calls("submit")))).String()}
	if value, has := dict.Get("generation_id"); has {
		text, ok := value.(string)
		if !ok {
			// В оригинале нестроковый ID отвергала проверка identifier: тот же неизвестный исход.
			return mediaapi.SubmitResult{}, failure(pycompat.ValueError, "Некорректный generationId.")
		}
		result.GenerationID = text
	}
	if value, has := dict.Get("credits_consumed"); has {
		result.CreditsConsumed = value
	}
	return result, nil
}

// Poll — состояние по конфигурации poll: объект или список (n-й опрос того же ID берёт n-й
// элемент, после конца — последний), "error" — отказ опроса.
func (s *Service) Poll(_ context.Context, directory string, request, state *pycompat.Dict, _ time.Duration) (mediaapi.PollResult, error) {
	generationID := state.Value("generation_id")
	previous := 0
	for _, entry := range s.Calls("poll") {
		if pycompat.Equal(entry.Value("generation_id"), generationID) {
			previous++
		}
	}
	if err := s.journal("poll", "work_dir", directory, "generation_id", generationID); err != nil {
		return mediaapi.PollResult{}, err
	}
	config := s.Config()
	answer, has := config.Get("poll")
	if !has {
		completed := pycompat.NewDict()
		completed.Set("status", "completed")
		answer = completed
	}
	if pycompat.Equal(answer, "error") {
		return mediaapi.PollResult{}, failure(pycompat.ValueError, "Тестовый сервис не ответил на запрос состояния.")
	}
	if list, ok := answer.([]any); ok {
		if len(list) == 0 {
			return mediaapi.PollResult{}, failure(pycompat.IndexError, "list index out of range")
		}
		answer = list[min(previous, len(list)-1)]
	}
	dict, ok := answer.(*pycompat.Dict)
	if !ok || !dict.Has("status") {
		return mediaapi.PollResult{}, failure(pycompat.KeyError, "'status'")
	}
	status, _ := dict.Value("status").(string)
	result := mediaapi.PollResult{Status: status, ServiceStatus: dict.Value("status")}
	if value, has := dict.Get("service_status"); has {
		result.ServiceStatus = value
		if value == nil {
			// Явный null — str(None) оригинала: в attempt.json попадёт «none», а не «unknown».
			result.ServiceStatus = "None"
		}
	}
	if status == "completed" {
		kind, _ := request.Value("kind").(string)
		output := "builtin:" + kind
		if files, ok := config.Value("results").(*pycompat.Dict); ok && files.Has(kind) {
			output = s.local(pycompat.Str(files.Value(kind)))
		}
		if value, has := dict.Get("outputs"); has {
			if list, ok := value.([]any); ok {
				result.Outputs = make([]string, len(list))
				for index, item := range list {
					result.Outputs[index] = pycompat.Str(item)
				}
			}
		} else {
			count, _ := request.Value("outputs").(pycompat.Int).Int64()
			for range count {
				result.Outputs = append(result.Outputs, output)
			}
		}
	}
	return result, nil
}

// Fetch — встроенные байты результата или копия файла из results; номер вызова из fetch_errors
// завершается OSError после записи в журнал.
func (s *Service) Fetch(_ context.Context, output, destination string) error {
	if err := s.journal("fetch", "output", output); err != nil {
		return err
	}
	if errors, ok := s.Config().Value("fetch_errors").([]any); ok {
		number := pycompat.NewInt(int64(len(s.Calls("fetch"))))
		for _, item := range errors {
			if pycompat.Equal(item, number) {
				return failure(pycompat.OSError, "SECRET")
			}
		}
	}
	switch output {
	case "builtin:video":
		return os.WriteFile(destination, BuiltinVideo, 0o666)
	case "builtin:image":
		return os.WriteFile(destination, BuiltinPNG, 0o666)
	}
	return requestsnapshot.CopyFile(output, destination)
}

// Account — остаток balance конфигурации (по умолчанию 1000, null — неизвестен).
func (s *Service) Account(context.Context, time.Duration) (mediaapi.Account, error) {
	if err := s.journal("account"); err != nil {
		return mediaapi.Account{}, err
	}
	value, has := s.Config().Get("balance")
	if !has {
		value = pycompat.NewInt(1000)
	}
	if value == nil {
		return mediaapi.Account{Source: "тестовый сервис не сообщил остаток"}, nil
	}
	balance, err := pycompat.Float(value)
	if err != nil {
		return mediaapi.Account{}, err
	}
	return mediaapi.Account{Balance: &balance, Source: "тестовый сервис"}, nil
}

// PricingFile — таблица цен из конфигурации pricing; по умолчанию pricing.json рядом с ней,
// при отсутствии создаётся пустая таблица (цены узнаются наблюдениями).
func (s *Service) PricingFile() (string, error) {
	path := filepath.Join(s.Dir, "pricing.json")
	if value := s.Config().Value("pricing"); pycompat.Truthy(value) {
		path = s.local(pycompat.Str(value))
	}
	if !pycompat.Exists(path) {
		if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
			return "", err
		}
		if err := os.WriteFile(path, []byte(`{"schema_version": 1, "models": {}, "observed": []}`), 0o666); err != nil {
			return "", err
		}
	}
	return path, nil
}

// Login — ответ login конфигурации {ok, message}.
func (s WithAuth) Login(_ context.Context, options mediaapi.LoginOptions) mediaapi.LoginResult {
	_ = s.journal("login", "open_browser", options.OpenBrowser)
	answer, _ := s.Config().Value("login").(*pycompat.Dict)
	message, _ := answer.Value("message").(string)
	return mediaapi.LoginResult{OK: pycompat.Truthy(answer.Value("ok")), Message: message}
}

// AuthStatus — ответ auth_status конфигурации {status, message?}.
func (s WithAuth) AuthStatus(context.Context, time.Duration) mediaapi.AuthStatus {
	_ = s.journal("auth_status")
	answer, _ := s.Config().Value("auth_status").(*pycompat.Dict)
	status, _ := answer.Value("status").(string)
	message, _ := answer.Value("message").(string)
	return mediaapi.AuthStatus{Status: status, Message: message}
}
