package referenceimage

import (
	"errors"
	"os"
	"path/filepath"
	"strings"

	"songframe-go/internal/agents"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/sources"
)

// Тексты контекста конструктора (referenceGenerationMessages,
// frontend/src/shared/texts/reference-images.ts).
const (
	TextContextInvalid  = "Не удалось прочитать контекст клипа. Проверьте название, идею, текст песни и визуальный стиль сценария."
	TextContextTooLarge = "Контекст изображения превышает 256 КБ. Сократите описание, идею или текст песни перед подготовкой."
)

// Context — ReferenceImageContext контракта: сведения клипа для конструктора промпта. Они не
// добавляются к отправляемому промпту автоматически.
type Context struct {
	ClipName    string `json:"clipName"`
	Idea        string `json:"idea"`
	Lyrics      string `json:"lyrics"`
	VisualStyle string `json:"visualStyle"`
}

// ContextDrafts — ReferenceImageContextDrafts: несохранённый текст формы «Исходники» важнее
// сохранённого. nil-поле — черновика нет; пустая строка — пустой черновик (не заменяется файлом).
type ContextDrafts struct {
	Idea   *string `json:"idea,omitempty"`
	Lyrics *string `json:"lyrics,omitempty"`
}

var (
	errContextInvalid  = errors.New(TextContextInvalid)
	errContextTooLarge = errors.New(TextContextTooLarge)
)

// contextText — строка без NUL не длиннее agents.TextLimit байт UTF-8.
func contextText(value any) (string, error) {
	text, ok := value.(string)
	if !ok || strings.ContainsRune(text, 0) {
		return "", errContextInvalid
	}
	if len(text) > agents.TextLimit {
		return "", errContextTooLarge
	}
	return text, nil
}

// readContextFile — текст файла контекста: размер проверяется до чтения, байты декодируются как
// UTF-8 (неверные последовательности — U+FFFD).
func readContextFile(path string) (string, error) {
	info, err := os.Stat(path)
	if err != nil {
		return "", err
	}
	if info.Size() > agents.TextLimit {
		return "", errContextTooLarge
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", err
	}
	return contextText(jscompat.DecodeUTF8(data))
}

// readContextJSON — объект JSON из файла; превышение размера остаётся своим
// отказом, остальные ошибки — «контекст не прочитан».
func readContextJSON(path string) (*jscompat.Object, error) {
	text, err := readContextFile(path)
	if errors.Is(err, errContextTooLarge) {
		return nil, err
	}
	if err != nil {
		return nil, errContextInvalid
	}
	value, err := jscompat.Parse([]byte(text))
	if err != nil {
		return nil, errContextInvalid
	}
	object, ok := value.(*jscompat.Object)
	if !ok {
		return nil, errContextInvalid
	}
	return object, nil
}

// ReadContext — referenceImages.context: название клипа,
// идея и текст песни (черновики формы важнее сохранённых файлов описи) и визуальный стиль
// сохранённого сценария. Только чтение: сессия не создаётся, файлы не пишутся.
//
// Отсутствующие до сценария файлы допустимы (пустая строка), но повреждённый используемый
// источник не пропускается молча: битая опись, явно указанный отсутствующий файл, путь вне
// source/, нестроковый стиль — TextContextInvalid. Превышение agents.TextLimit отдельным
// источником или всем ответом (JSON) — TextContextTooLarge, без усечения.
func ReadContext(project string, drafts *ContextDrafts) (Context, error) {
	if !jscompat.IsAbs(project) || strings.ContainsRune(project, 0) {
		return Context{}, errContextInvalid
	}
	canonical, err := jscompat.Realpath(project)
	if err != nil {
		return Context{}, errContextInvalid
	}
	projectData, err := readContextJSON(filepath.Join(canonical, "plan", "project.json"))
	if err != nil {
		return Context{}, err
	}
	clipName, err := contextText(projectData.Value("name"))
	if err != nil {
		return Context{}, err
	}
	if jscompat.Trim(clipName) == "" {
		return Context{}, errContextInvalid
	}
	if drafts == nil {
		drafts = &ContextDrafts{}
	}
	source := filepath.Join(canonical, "source")
	needsSaved := drafts.Idea == nil || drafts.Lyrics == nil
	var manifest any
	if needsSaved {
		manifest = sources.ReadManifest(canonical)
		if jscompat.Exists(filepath.Join(source, "manifest.json")) && manifest == nil {
			return Context{}, errContextInvalid
		}
	}
	saved := func(field, fallback string) (string, error) {
		descriptor := jscompat.Get(manifest, field)
		named := !jscompat.IsNullish(descriptor)
		name := fallback
		if named {
			path, ok := jscompat.Get(descriptor, "path").(string)
			if !jscompat.IsRecord(descriptor) || !ok || jscompat.Trim(path) == "" {
				return "", errContextInvalid
			}
			name = path
		}
		path := jscompat.Resolve(source, name)
		local := jscompat.Relative(source, path)
		if jscompat.IsAbs(name) || local == ".." || strings.HasPrefix(local, ".."+string(filepath.Separator)) {
			return "", errContextInvalid
		}
		if !jscompat.Exists(path) {
			if named {
				return "", errContextInvalid
			}
			return "", nil
		}
		text, err := readContextFile(path)
		if errors.Is(err, errContextTooLarge) {
			return "", err
		}
		if err != nil {
			return "", errContextInvalid
		}
		return text, nil
	}
	pick := func(draft *string, field, fallback string) (string, error) {
		if draft != nil {
			return contextText(*draft)
		}
		return saved(field, fallback)
	}
	idea, err := pick(drafts.Idea, "idea", "description.md")
	if err != nil {
		return Context{}, err
	}
	lyrics, err := pick(drafts.Lyrics, "lyrics", "text.md")
	if err != nil {
		return Context{}, err
	}
	visualStyle := ""
	scenes := filepath.Join(canonical, "plan", "scenes.json")
	if jscompat.Exists(scenes) {
		document, err := readContextJSON(scenes)
		if err != nil {
			return Context{}, err
		}
		if visualStyle, err = contextText(document.Value("visual_direction")); err != nil {
			return Context{}, err
		}
	}
	result := Context{ClipName: clipName, Idea: idea, Lyrics: lyrics, VisualStyle: visualStyle}
	encoded := jscompat.NewObject()
	encoded.Set("clipName", result.ClipName)
	encoded.Set("idea", result.Idea)
	encoded.Set("lyrics", result.Lyrics)
	encoded.Set("visualStyle", result.VisualStyle)
	if len(jscompat.Stringify(encoded)) > agents.TextLimit {
		return Context{}, errContextTooLarge
	}
	return result, nil
}
