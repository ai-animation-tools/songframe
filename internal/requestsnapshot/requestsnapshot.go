// Package requestsnapshot готовит неизменяемый запрос генерации локально, без отправки: снимок
// спецификации, промпта и входов в новой папке попытки и атомарная запись его JSON.
//
// Пакет не отправляет запросы и не выбирает провайдера: допустимую рабочую папку проверяет
// вызывающий (internal/mediarequest), ограничения сервиса — его адаптер. Байты request.json и
// attempt.json, а значит и request_sha256, зафиксированы эталоном request-snapshot: JSON пишется
// моделью значений pycompat (sort_keys, indent=2, ensure_ascii=False, allow_nan=False) + "\n".
package requestsnapshot

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"path/filepath"
	"regexp"
	"strings"

	"songframe-go/internal/projectfs"
	"songframe-go/internal/pycompat"
)

// Тексты отказов (ValueError): media_request показывает их пользователю как есть.
const (
	textUnknownSchema    = "Неизвестная схема запроса."
	textNoKind           = "Не указан вид результата."
	textUnknownFields    = "Неизвестные поля запроса."
	textParameters       = "parameters должен быть объектом."
	textOutputs          = "Неверное число результатов."
	textInputsList       = "inputs должен быть списком."
	textInputFields      = "Неизвестные поля входа."
	textSlot             = "slot должен быть непустой строкой."
	textInputSHA         = "У входа нет корректного SHA-256."
	textSelectionFields  = "model_selection должен содержать только preferredModel, selectedModel и reason."
	textPreferredModel   = "preferredModel должен быть идентификатором модели или null."
	textSelectedModel    = "selectedModel должен совпадать с model запроса."
	textSelectionReason  = "reason должен быть непустой строкой с причиной выбора модели."
	textDirectoryExists  = "Нужна новая папка попытки; существующая не перезаписывается."
	textEmptyPrompt      = "Промпт пуст."
	textInputHashChanged = "Хеш входа отличается от указанного в запросе."
	textInputChanged     = "Вход изменился при подготовке."
)

// specFields — допустимые поля спецификации запроса; inputFields — допустимые поля входа.
var (
	specFields = map[string]bool{
		"schema_version": true, "shot": true, "provider": true, "kind": true, "command": true, "model": true,
		"model_selection": true, "parameters": true, "outputs": true, "inputs": true, "prompt_file": true,
	}
	inputFields     = map[string]bool{"flag": true, "slot": true, "role": true, "path": true, "sha256": true}
	selectionFields = []string{"preferredModel", "selectedModel", "reason"}
	sha256Pattern   = regexp.MustCompile(`^[a-f0-9]{64}$`)
)

// Encoded — байты JSON зафиксированного запроса и журнала попытки. От них
// считается request_sha256, поэтому формат неизменен: ключи по кодовым точкам, отступ 2,
// не-ASCII как есть, NaN/бесконечность и одиночный суррогат — ValueError/UnicodeEncodeError.
func Encoded(value any) ([]byte, error) {
	text, err := pycompat.DumpsJSON(value, pycompat.DumpOptions{Indent: 2, Pretty: true, SortKeys: true, RejectNaN: true})
	if err != nil {
		return nil, err
	}
	return pycompat.EncodeUTF8(text + "\n")
}

// Digest — SHA-256 байтов Encoded(value) в hex: SHA подготовленного запроса.
func Digest(value any) (string, error) {
	data, err := Encoded(value)
	if err != nil {
		return "", err
	}
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:]), nil
}

// AtomicJSON заменяет файл через соседний временный файл со сбросом
// на диск. Состояние отправки должно пережить обрыв до получения ID; подписанные адреса и сырые
// ответы сервиса сюда не попадают. Права нового файла 0600, как у NamedTemporaryFile Python.
// Ошибка записи — OSError (в CLI — общее сообщение без пути).
func AtomicJSON(path string, value any) error {
	data, err := Encoded(value)
	if err != nil {
		return err
	}
	if err := projectfs.WriteFile(path, data, 0o600); err != nil {
		return pycompat.OSErrorFrom(err, path)
	}
	return nil
}

// FileSHA — SHA-256 файла потоком. Ошибка — OSError Python.
func FileSHA(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", pycompat.OSErrorFrom(err, path)
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", pycompat.OSErrorFrom(err, path)
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

// nonEmptyString — isinstance(value, str) and value.strip().
func nonEmptyString(value any) bool {
	text, ok := value.(string)
	return ok && pycompat.Strip(text) != ""
}

// ValidateSpec проверяет общую форму спецификации без предположений о командах и слотах
// провайдера. spec — любое значение json.loads; нарушение — ValueError, сообщение даёт первая
// нарушенная проверка, поэтому порядок проверок зафиксирован эталоном.
func ValidateSpec(value any) error {
	spec, ok := value.(*pycompat.Dict)
	if !ok || !pycompat.Equal(spec.Value("schema_version"), pycompat.NewInt(1)) {
		return pycompat.New(pycompat.ValueError, textUnknownSchema)
	}
	for _, field := range []string{"provider", "command", "model", "prompt_file"} {
		if !nonEmptyString(spec.Value(field)) {
			return pycompat.New(pycompat.ValueError, "Поле "+field+" должно быть непустой строкой.")
		}
	}
	if kind := spec.Value("kind"); !pycompat.Equal(kind, "image") && !pycompat.Equal(kind, "video") {
		return pycompat.New(pycompat.ValueError, textNoKind)
	}
	for _, key := range spec.Keys() {
		if !specFields[key] {
			return pycompat.New(pycompat.ValueError, textUnknownFields)
		}
	}
	parameters, hasParameters := spec.Get("parameters")
	if !hasParameters {
		parameters = pycompat.NewDict()
	}
	if _, ok := parameters.(*pycompat.Dict); !ok {
		return pycompat.New(pycompat.ValueError, textParameters)
	}
	count, hasCount := spec.Get("outputs")
	if !hasCount {
		count = pycompat.NewInt(1)
	}
	if number, ok := count.(pycompat.Int); !ok || number.Sign() < 1 {
		return pycompat.New(pycompat.ValueError, textOutputs)
	}
	inputs, hasInputs := spec.Get("inputs")
	if !hasInputs {
		inputs = []any{}
	}
	list, ok := inputs.([]any)
	if !ok {
		return pycompat.New(pycompat.ValueError, textInputsList)
	}
	for _, element := range list {
		item, ok := element.(*pycompat.Dict)
		if !ok {
			return pycompat.New(pycompat.ValueError, textInputFields)
		}
		for _, key := range item.Keys() {
			if !inputFields[key] {
				return pycompat.New(pycompat.ValueError, textInputFields)
			}
		}
		for _, field := range []string{"flag", "path"} {
			if !nonEmptyString(item.Value(field)) {
				return pycompat.New(pycompat.ValueError, "У входа нет непустого "+field+".")
			}
		}
		if slot, has := item.Get("slot"); has && !nonEmptyString(slot) {
			return pycompat.New(pycompat.ValueError, textSlot)
		}
		if digest, has := item.Get("sha256"); has {
			text, ok := digest.(string)
			if !ok || !sha256Pattern.MatchString(text) {
				return pycompat.New(pycompat.ValueError, textInputSHA)
			}
		}
	}
	if value, has := spec.Get("model_selection"); has {
		selection, ok := value.(*pycompat.Dict)
		if !ok || selection.Len() != len(selectionFields) || !hasAll(selection, selectionFields) {
			return pycompat.New(pycompat.ValueError, textSelectionFields)
		}
		if preferred := selection.Value("preferredModel"); preferred != nil && !nonEmptyString(preferred) {
			return pycompat.New(pycompat.ValueError, textPreferredModel)
		}
		if !pycompat.Equal(selection.Value("selectedModel"), spec.Value("model")) {
			return pycompat.New(pycompat.ValueError, textSelectedModel)
		}
		if !nonEmptyString(selection.Value("reason")) {
			return pycompat.New(pycompat.ValueError, textSelectionReason)
		}
	}
	// Параметры должны кодироваться без NaN и одиночных суррогатов: иначе SHA не посчитать.
	_, err := Encoded(parameters)
	return err
}

// hasAll — все ключи есть в словаре (set(selection) == {...} при равной длине).
func hasAll(dict *pycompat.Dict, keys []string) bool {
	for _, key := range keys {
		if !dict.Has(key) {
			return false
		}
	}
	return true
}

// Prepare готовит попытку; результат — зафиксированный запрос, дополненный полями
// request_sha256, prompt_text, work_dir и warnings (warnings пуст, его дополняет вызывающий
// предупреждениями адаптера). Читает спецификацию request (пути промпта и входов отсчитываются
// от её папки), проверяет общую форму и создаёт новую
// папку directory с prompt.txt, inputs/, request.json и attempt.json (status prepared).
//
// Папка появляется только целиком: всё собирается во временной .prepare-* рядом и
// переименовывается в конце, поэтому недописанный запрос отправить нельзя. Одинаковые байты
// входов копируются один раз с сохранением всех ролей. extraFields (FrozenFields адаптера)
// входят в запрос и его SHA. Существующая папка не перезаписывается.
func Prepare(request, directory string, extraFields *pycompat.Dict) (*pycompat.Dict, error) {
	request = pycompat.ResolvePath(request)
	directory = pycompat.ResolvePath(directory)
	value, err := pycompat.LoadJSONFile(request)
	if err != nil {
		return nil, err
	}
	if err := ValidateSpec(value); err != nil {
		return nil, err
	}
	spec := value.(*pycompat.Dict)
	if pycompat.Exists(directory) {
		return nil, pycompat.New(pycompat.ValueError, textDirectoryExists)
	}
	base := filepath.Dir(request)
	promptSource := pycompat.ResolvePath(pycompat.JoinPath(base, spec.Value("prompt_file").(string)))
	promptBytes, err := os.ReadFile(promptSource)
	if err != nil {
		return nil, pycompat.OSErrorFrom(err, promptSource)
	}
	prompt, err := pycompat.DecodeUTF8(promptBytes)
	if err != nil {
		return nil, err
	}
	if pycompat.Strip(prompt) == "" {
		return nil, pycompat.New(pycompat.ValueError, textEmptyPrompt)
	}
	parent := filepath.Dir(directory)
	if err := os.MkdirAll(parent, 0o777); err != nil {
		return nil, pycompat.OSErrorFrom(err, parent)
	}
	staging, err := os.MkdirTemp(parent, ".prepare-")
	if err != nil {
		return nil, pycompat.OSErrorFrom(err, parent)
	}
	// Временная заготовка: после переименования удалять нечего, при отказе удаляется целиком.
	defer os.RemoveAll(staging)
	frozen, digest, err := freeze(spec, base, staging, promptBytes, extraFields)
	if err != nil {
		return nil, err
	}
	if err := os.Rename(staging, directory); err != nil {
		return nil, pycompat.OSErrorFrom(err, staging)
	}
	result := frozen.Clone()
	result.Set("request_sha256", digest)
	result.Set("prompt_text", prompt)
	result.Set("work_dir", directory)
	result.Set("warnings", []any{})
	return result, nil
}

// freeze собирает содержимое попытки в staging и возвращает зафиксированный запрос и его SHA.
func freeze(spec *pycompat.Dict, base, staging string, promptBytes []byte, extraFields *pycompat.Dict) (*pycompat.Dict, string, error) {
	if err := os.Mkdir(filepath.Join(staging, "inputs"), 0o777); err != nil {
		return nil, "", pycompat.OSErrorFrom(err, staging)
	}
	promptPath := filepath.Join(staging, "prompt.txt")
	if err := os.WriteFile(promptPath, promptBytes, 0o666); err != nil {
		return nil, "", pycompat.OSErrorFrom(err, promptPath)
	}
	inputs := []any{}
	copies := map[string]string{}
	specInputs, _ := spec.Value("inputs").([]any)
	for index, element := range specInputs {
		item := element.(*pycompat.Dict)
		source := pycompat.ResolvePath(pycompat.JoinPath(base, item.Value("path").(string)))
		digest, err := FileSHA(source)
		if err != nil {
			return nil, "", err
		}
		if declared, has := item.Get("sha256"); has && declared != digest {
			return nil, "", pycompat.New(pycompat.ValueError, textInputHashChanged)
		}
		name, copied := copies[digest]
		if !copied {
			name = "inputs/" + twoDigits(index+1) + strings.ToLower(pycompat.PathSuffix(source))
			target := filepath.Join(staging, filepath.FromSlash(name))
			if err := copyFile(source, target); err != nil {
				return nil, "", err
			}
			if again, err := FileSHA(target); err != nil {
				return nil, "", err
			} else if again != digest {
				return nil, "", pycompat.New(pycompat.ValueError, textInputChanged)
			}
			copies[digest] = name
		}
		info, err := os.Stat(source)
		if err != nil {
			return nil, "", pycompat.OSErrorFrom(err, source)
		}
		entry := pycompat.NewDict()
		for _, key := range []string{"flag", "slot", "role"} {
			if value, has := item.Get(key); has {
				entry.Set(key, value)
			}
		}
		entry.Set("path", name)
		entry.Set("sha256", digest)
		entry.Set("bytes", pycompat.NewInt(info.Size()))
		inputs = append(inputs, entry)
	}
	promptDigest, err := FileSHA(promptPath)
	if err != nil {
		return nil, "", err
	}
	frozen := pycompat.NewDict()
	frozen.Set("schema_version", pycompat.NewInt(1))
	frozen.Set("shot", spec.Value("shot"))
	frozen.Set("provider", spec.Value("provider"))
	frozen.Set("kind", spec.Value("kind"))
	frozen.Set("command", spec.Value("command"))
	frozen.Set("model", spec.Value("model"))
	frozen.Set("parameters", valueOr(spec, "parameters", pycompat.NewDict()))
	frozen.Set("outputs", valueOr(spec, "outputs", pycompat.NewInt(1)))
	frozen.Set("inputs", inputs)
	prompt := pycompat.NewDict()
	prompt.Set("path", "prompt.txt")
	prompt.Set("sha256", promptDigest)
	frozen.Set("prompt", prompt)
	// Метаданные адаптера входят в тот же SHA, но не навязываются другим провайдерам.
	for _, key := range extraFields.Keys() {
		frozen.Set(key, extraFields.Value(key))
	}
	if selection, has := spec.Get("model_selection"); has {
		frozen.Set("model_selection", selection)
	}
	digest, err := Digest(frozen)
	if err != nil {
		return nil, "", err
	}
	if err := AtomicJSON(filepath.Join(staging, "request.json"), frozen); err != nil {
		return nil, "", err
	}
	state := pycompat.NewDict()
	state.Set("schema_version", pycompat.NewInt(1))
	state.Set("request_sha256", digest)
	state.Set("status", "prepared")
	state.Set("downloads", []any{})
	if err := AtomicJSON(filepath.Join(staging, "attempt.json"), state); err != nil {
		return nil, "", err
	}
	return frozen, digest, nil
}

// valueOr — spec.get(key, fallback).
func valueOr(dict *pycompat.Dict, key string, fallback any) any {
	if value, has := dict.Get(key); has {
		return value
	}
	return fallback
}

// twoDigits — f"{number:02}".
func twoDigits(number int) string {
	text := pycompat.NewInt(int64(number)).String()
	if len(text) < 2 {
		return "0" + text
	}
	return text
}

// CopyFile — shutil.copyfile(source, target): байты без метаданных; цель перезаписывается.
// Ошибка — OSError Python.
func CopyFile(source, target string) error { return copyFile(source, target) }

func copyFile(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return pycompat.OSErrorFrom(err, source)
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o666)
	if err != nil {
		return pycompat.OSErrorFrom(err, target)
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return pycompat.OSErrorFrom(err, target)
	}
	if err := output.Close(); err != nil {
		return pycompat.OSErrorFrom(err, target)
	}
	return nil
}
