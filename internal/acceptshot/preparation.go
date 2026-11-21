package acceptshot

import (
	"strings"

	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// framePreparation — сведения подготовки опор попытки для preparation.json: промпты опор и
// референсы, а также файлы, которые приёмка кладёт в комплект (описание плана и кадры других
// планов из continuity/ попытки). Пустые списки — попытки нет или у неё нет плана опор.
type framePreparation struct {
	// prompts — frame_prompts: опора плана, её промпт, промпт генератора и действовавшие замечания.
	prompts []any
	// references — references: уникальные референсы опор в порядке первого упоминания.
	references []any
	// files — дескрипторы скопированных в комплект файлов (входят в generation.preparation.files).
	files []any
	// description — имя файла описания плана в комплекте; "" — у попытки нет описания.
	description string
}

// collectPreparation читает план опор (keyframe-prompts.json), опоры и замечания workflow.json и
// описание (description.md) попытки data и копирует нужные файлы в staging. Общие референсы из
// source/ остаются ссылками с SHA-256 на момент приёмки; кадры других планов, которые попытка
// хранит у себя, копируются в комплект: папка попытки после приёмки может быть убрана. Комплекты,
// принятые раньше, не перечитываются: статус плана зависит от отпечатка сценария, а не от этих
// сведений.
func collectPreparation(root string, data attemptData, staging string) (framePreparation, error) {
	result := framePreparation{prompts: []any{}, references: []any{}, files: []any{}}
	if data.packageDir == "" {
		return result, nil
	}
	if source := toolrt.JoinPath(data.packageDir, "description.md"); toolrt.IsFile(source) {
		if err := copyFile(source, toolrt.JoinPath(staging, "description.md")); err != nil {
			return result, err
		}
		entry, err := descriptor(staging, "description.md")
		if err != nil {
			return result, err
		}
		result.files = append(result.files, entry)
		result.description = "description.md"
	}
	plan := toolrt.JoinPath(data.packageDir, "keyframe-prompts.json")
	if !toolrt.IsFile(plan) {
		return result, nil
	}
	value, err := loadJSON(plan)
	if err != nil {
		return result, err
	}
	frames, _ := value.([]any)
	keyframes := map[string]*toolrt.Dict{}
	var notes []any
	if data.workflow != nil {
		items, _ := data.workflow.Value("keyframes").([]any)
		for _, item := range items {
			if frame := dict(item); frame != nil {
				keyframes[toolrt.Str(frame.Value("id"))] = frame
			}
		}
		notes, _ = data.workflow.Value("keyframe_notes").([]any)
	}
	seen := map[string]bool{}
	for _, item := range frames {
		frame := dict(item)
		if frame == nil {
			continue
		}
		id := toolrt.Str(frame.Value("id"))
		paths, _ := frame.Value("referencePaths").([]any)
		for _, raw := range paths {
			path, ok := raw.(string)
			if !ok || seen[path] {
				continue
			}
			seen[path] = true
			entry, copied, err := referenceEntry(root, data.packageDir, staging, path)
			if err != nil {
				return result, err
			}
			result.references = append(result.references, entry)
			if copied != nil {
				result.files = append(result.files, copied)
			}
		}
		keyframe := keyframes[id]
		var generatorPrompt, sha any
		if keyframe != nil {
			if text, ok := keyframe.Value("generator_prompt").(string); ok {
				generatorPrompt = text
			}
			if toolrt.Truthy(keyframe.Value("approved")) {
				sha = keyframe.Value("sha256")
			}
		}
		pairs := []any{"id", id, "role", frame.Value("role"), "time_seconds", frame.Value("timeSeconds")}
		if frame.Has("copyOf") {
			pairs = append(pairs, "copy_of", frame.Value("copyOf"))
		}
		pairs = append(pairs, "prompt", frame.Value("prompt"), "generator_prompt", generatorPrompt,
			"reference_paths", referencePaths(paths), "notes", frameNotes(notes, id), "sha256", sha)
		result.prompts = append(result.prompts, toolcli.Record(pairs...))
	}
	return result, nil
}

// referencePaths — пути референсов опоры как их записал план опор (от проекта); не строки
// пропускаются.
func referencePaths(paths []any) []any {
	result := []any{}
	for _, raw := range paths {
		if path, ok := raw.(string); ok {
			result = append(result, path)
		}
	}
	return result
}

// frameNotes — действующие замечания пользователя к опоре id: её собственные и сквозные (scope
// following), кроме снятых, — тот же отбор, что у задания опор (productionworkflow FrameNotes).
func frameNotes(notes []any, id string) []any {
	result := []any{}
	for _, item := range notes {
		note := dict(item)
		if note == nil {
			continue
		}
		text, _ := note.Value("note").(string)
		text = strings.TrimSpace(text)
		if text == "" || !toolrt.Truthy(note.Value("active")) {
			continue
		}
		if toolrt.Equal(note.Value("scope"), "following") || toolrt.Equal(note.Value("frame"), id) {
			result = append(result, text)
		}
	}
	return result
}

// referenceEntry — запись references для пути плана опор path (от проекта): изображение из source/
// — ссылкой root "source" с SHA-256 и размером (sha256 null, если файла уже нет); файл внутри
// попытки packageDir (кадр другого плана в continuity/) — копией reference-<имя> в staging с
// дескриптором для generation.preparation.files. Иной путь сохраняется только строкой plan_path.
func referenceEntry(root, packageDir, staging, path string) (*toolrt.Dict, *toolrt.Dict, error) {
	sourceDir := toolrt.ResolvePath(toolrt.JoinPath(root, "source"))
	file := toolrt.ResolvePath(toolrt.JoinPath(root, path))
	if relative, ok := strings.CutPrefix(path, "source/"); ok && toolrt.IsRelativeTo(file, sourceDir) {
		var digest, size any
		if toolrt.IsFile(file) {
			entry, err := descriptor(toolrt.JoinPath(root, "source"), relative)
			if err != nil {
				return nil, nil, err
			}
			digest, size = entry.Value("sha256"), entry.Value("bytes")
		}
		return toolcli.Record("plan_path", path, "root", "source", "path", relative, "sha256", digest, "bytes", size), nil, nil
	}
	if toolrt.IsRelativeTo(file, toolrt.ResolvePath(packageDir)) && toolrt.IsFile(file) {
		name := "reference-" + toolrt.PathName(file)
		if err := copyFile(file, toolrt.JoinPath(staging, name)); err != nil {
			return nil, nil, err
		}
		copied, err := descriptor(staging, name)
		if err != nil {
			return nil, nil, err
		}
		entry := toolcli.Record("plan_path", path, "path", name, "sha256", copied.Value("sha256"), "bytes", copied.Value("bytes"))
		return entry, copied, nil
	}
	return toolcli.Record("plan_path", path), nil, nil
}
