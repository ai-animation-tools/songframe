package requestsnapshot

import (
	"os"
	"path/filepath"

	"songframe/internal/toolrt"
)

// ManualInput — файл пакета ручной генерации: абсолютный путь источника, слот (image или audio)
// и роль для человека («Опора K01», «Срез речи»).
type ManualInput struct {
	Path, Slot, Role string
}

// ManualSpec — пакет ручной генерации: план, провайдер видео проекта, длительность запроса,
// текст утверждённого видеопромпта и входы.
type ManualSpec struct {
	Shot, Provider string
	Seconds        int64
	Prompt         string
	Inputs         []ManualInput
}

// PrepareManual собирает в новой папке directory пакет для генерации вне приложения: prompt.txt,
// копии входов inputs/NN.* с SHA, request.json с mode=manual (без команды и модели сервиса) и
// attempt.json в состоянии manual_pending. Отправлять такой запрос нечем: результат загружает
// пользователь (mediarequest.AttachManual). Устройство то же, что у Prepare: папка появляется
// целиком после переименования, существующая не перезаписывается.
func PrepareManual(directory string, spec ManualSpec) (*toolrt.Dict, error) {
	directory = toolrt.ResolvePath(directory)
	if toolrt.Exists(directory) {
		return nil, toolrt.New(toolrt.ValueError, textDirectoryExists)
	}
	if toolrt.Strip(spec.Prompt) == "" {
		return nil, toolrt.New(toolrt.ValueError, textEmptyPrompt)
	}
	promptBytes, err := toolrt.EncodeUTF8(spec.Prompt)
	if err != nil {
		return nil, err
	}
	inputs := []any{}
	for _, input := range spec.Inputs {
		entry := toolrt.NewDict()
		entry.Set("path", toolrt.ResolvePath(input.Path))
		entry.Set("slot", input.Slot)
		entry.Set("role", input.Role)
		inputs = append(inputs, entry)
	}
	parameters := toolrt.NewDict()
	parameters.Set("duration", toolrt.NewInt(spec.Seconds))
	frozenSpec := toolrt.NewDict()
	frozenSpec.Set("shot", spec.Shot)
	frozenSpec.Set("provider", spec.Provider)
	frozenSpec.Set("kind", "video")
	frozenSpec.Set("command", nil)
	frozenSpec.Set("model", nil)
	frozenSpec.Set("parameters", parameters)
	frozenSpec.Set("outputs", toolrt.NewInt(1))
	frozenSpec.Set("inputs", inputs)
	extra := toolrt.NewDict()
	extra.Set("mode", "manual")
	parent := filepath.Dir(directory)
	if err := os.MkdirAll(parent, 0o777); err != nil {
		return nil, toolrt.OSErrorFrom(err, parent)
	}
	staging, err := os.MkdirTemp(parent, ".prepare-")
	if err != nil {
		return nil, toolrt.OSErrorFrom(err, parent)
	}
	defer os.RemoveAll(staging)
	// Пути входов абсолютные: база для них не нужна.
	frozen, digest, err := freeze(frozenSpec, parent, staging, promptBytes, extra, "manual_pending")
	if err != nil {
		return nil, err
	}
	if err := os.Rename(staging, directory); err != nil {
		return nil, toolrt.OSErrorFrom(err, staging)
	}
	result := frozen.Clone()
	result.Set("request_sha256", digest)
	result.Set("work_dir", directory)
	return result, nil
}
