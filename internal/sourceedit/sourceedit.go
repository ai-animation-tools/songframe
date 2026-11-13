// Package sourceedit ведёт форму «Исходники»: просмотр, проверку и сохранение трека, текста
// песни, идеи, обложки и референсов в source/ вместе с описью source/manifest.json. Имена трека
// и текстов фиксированы (track.mp3, text.md, description.md): их читают разметка, статус и кастинг.
//
// Пакет отделён от internal/sources (чтение описи для статуса и кастинга), потому что проверке
// нужен разбор текста песни из internal/timing, а timing сам зависит от sources.
//
// Файлы, имена изображений, промпты, порядок полей описи и тексты проблем зафиксированы эталонами
// testdata/golden/sources-*. Прежняя опись читается деревом dynvalue, поэтому неизвестные поля
// трека, текста, идеи, обложки и типов сохраняются как есть. Каждый файл заменяется атомарно
// (временный файл и rename), запись проходит шлюз projectfs, а удаление по путям прежней описи
// не выходит за пределы source/.
package sourceedit

import (
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"math"
	"os"
	"path"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"

	"songframe/internal/dynvalue"
	"songframe/internal/process"
	"songframe/internal/projectfs"
	"songframe/internal/sources"
	"songframe/internal/timing"
)

// Фиксированные имена в source/.
const (
	sourceDir    = "source"
	manifestName = "manifest.json"
	trackName    = "track.mp3"
	lyricsName   = "text.md"
	ideaName     = "description.md"
	reservedKind = "world"
)

// Kind — тип референсов: код, подпись и папка внутри source.
type Kind struct {
	ID    string `json:"id"`
	Label string `json:"label"`
	Dir   string `json:"dir"`
}

// DefaultKinds — виды референсов по умолчанию (тот же список у интерфейса в
// frontend/src/shared/types.ts): подписи сохраняются в описи и принадлежат формату данных.
var DefaultKinds = []Kind{
	{ID: "character", Label: "Персонаж", Dir: "heroes"},
	{ID: "vehicle", Label: "Транспорт", Dir: "vehicles"},
	{ID: "location", Label: "Локация", Dir: "locations"},
	{ID: "prop", Label: "Предмет", Dir: "props"},
	{ID: "style", Label: "Стиль", Dir: "style"},
}

// PathInput — новый файл формы по абсолютному пути.
type PathInput struct {
	Path string `json:"path"`
}

// TextInput — текст песни или идея: файл ({path}) либо введённый текст ({text}).
// Ровно одно поле задано; если есть ключ path, он имеет приоритет.
type TextInput struct {
	Path *string `json:"path,omitempty"`
	Text *string `json:"text,omitempty"`
}

// CoverInput — новая обложка ({path}) или её удаление ({remove: true}).
type CoverInput struct {
	Path   *string `json:"path,omitempty"`
	Remove *bool   `json:"remove,omitempty"`
}

// FileInput — изображение референса: новый файл (SourcePath, абсолютный) или уже сохранённый
// (ExistingPath внутри source). Prompt nil сохраняет прежнюю привязку промпта, "" её снимает.
type FileInput struct {
	SourcePath   *string `json:"sourcePath,omitempty"`
	ExistingPath *string `json:"existingPath,omitempty"`
	View         *string `json:"view,omitempty"`
	Note         string  `json:"note"`
	Prompt       *string `json:"prompt,omitempty"`
}

// ReferenceInput — референс формы; Prompt — общий промпт, не относящийся к отдельным изображениям.
type ReferenceInput struct {
	ID          string      `json:"id"`
	Kind        string      `json:"kind"`
	Name        string      `json:"name"`
	ShortName   string      `json:"short_name"`
	Description string      `json:"description"`
	Prompt      string      `json:"prompt"`
	Files       []FileInput `json:"files"`
}

// Input — SourcesInput: nil-поля оставляют сохранённое; Kinds nil — набор из описи или по умолчанию.
type Input struct {
	Kinds      *[]Kind          `json:"kinds,omitempty"`
	Track      *PathInput       `json:"track"`
	Lyrics     *TextInput       `json:"lyrics"`
	Idea       *TextInput       `json:"idea"`
	Cover      *CoverInput      `json:"cover"`
	References []ReferenceInput `json:"references"`
}

// View — SourcesView. Manifest — опись как есть (неизвестные поля сохраняются) или null.
// CoverPath и ReferenceFilePaths — абсолютные пути текущего сеанса для предпросмотра.
type View struct {
	Manifest           json.RawMessage   `json:"manifest"`
	LyricsText         string            `json:"lyricsText"`
	IdeaText           string            `json:"ideaText"`
	CoverPath          *string           `json:"coverPath"`
	ReferenceFilePaths map[string]string `json:"referenceFilePaths"`
	Problems           []string          `json:"problems"`
	// PinnedReferences — код референса → планы с готовыми материалами, которые его используют. Файлы
	// таких референсов при смене типа остаются в прежней папке (SaveOptions.Pinned); заполняет
	// internal/app через internal/referenceimage.
	PinnedReferences map[string][]string `json:"pinnedReferences"`
	// EntityKinds — код сущности кастинга → её тип: новый референс с тем же кодом берёт тип сущности.
	// Без кастинга пусто.
	EntityKinds map[string]string `json:"entityKinds"`
}

// Тексты sourcesTexts.main (frontend/src/shared/texts/sources.ts).
const (
	kindReserved          = "Тип world зарезервирован для общих условий планов."
	unnamedReference      = "(без имени)"
	trackLabel            = "Трек"
	lyricsLabel           = "Текст песни"
	ideaLabel             = "Идея"
	coverLabel            = "Обложка"
	clipIdeaLabel         = "Идея клипа"
	trackRequired         = "Трек обязателен."
	trackFormatInvalid    = "Трек должен быть в формате MP3."
	lyricsRequired        = "Текст песни обязателен."
	ideaRequired          = "Идея клипа обязательна."
	coverFormatInvalid    = "Обложка: допустимы PNG, JPG и WebP."
	referenceLabelPrefix  = "Референс "
	manifestFileMissingFn = "%s: файл %s отсутствует."
)

var (
	slugPattern    = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	dirSlugPattern = regexp.MustCompile(`^[a-z][a-z0-9_-]*$`)
)

var imageExtensions = map[string]bool{".png": true, ".jpg": true, ".jpeg": true, ".webp": true}

// extname — расширение имени файла от последней точки, если она не первая; иначе "".
func extname(path string) string {
	name := dynvalue.Basename(path)
	index := strings.LastIndex(name, ".")
	if index <= 0 {
		return ""
	}
	return name[index:]
}

// manifestKinds превращает kinds прежней описи в список; nil — поля нет (действует набор по умолчанию).
func manifestKinds(previous any) ([]Kind, bool) {
	list, ok := dynvalue.AsArray(dynvalue.Get(previous, "kinds"))
	if !ok {
		return nil, false
	}
	kinds := make([]Kind, 0, len(list))
	for _, item := range list {
		kind := Kind{}
		kind.ID, _ = dynvalue.Get(item, "id").(string)
		kind.Label, _ = dynvalue.Get(item, "label").(string)
		kind.Dir, _ = dynvalue.Get(item, "dir").(string)
		kinds = append(kinds, kind)
	}
	return kinds, true
}

// resolveKinds — типы из ввода, иначе из описи, иначе набор по умолчанию. Второе значение —
// значение для записи в опись: kinds прежней описи переносятся как есть, с неизвестными полями.
func resolveKinds(input *Input, previous any) ([]Kind, any) {
	if input != nil && input.Kinds != nil {
		return *input.Kinds, kindsValue(*input.Kinds)
	}
	if kinds, ok := manifestKinds(previous); ok {
		return kinds, dynvalue.Get(previous, "kinds")
	}
	return DefaultKinds, kindsValue(DefaultKinds)
}

func kindsValue(kinds []Kind) *dynvalue.Array {
	items := make([]any, 0, len(kinds))
	for _, kind := range kinds {
		object := dynvalue.NewObject()
		object.Set("id", kind.ID)
		object.Set("label", kind.Label)
		object.Set("dir", kind.Dir)
		items = append(items, object)
	}
	return &dynvalue.Array{Items: items}
}

// ValidateKinds проверяет коды, подписи и папки типов, без повторов; world зарезервирован.
func ValidateKinds(kinds []Kind) []string {
	problems := []string{}
	ids, dirs := map[string]bool{}, map[string]bool{}
	for _, kind := range kinds {
		label := kind.Label
		if label == "" {
			label = kind.ID
		}
		if !slugPattern.MatchString(kind.ID) {
			problems = append(problems, "Код типа «"+label+"»: латиница в нижнем регистре, цифры и подчёркивание.")
		}
		if kind.ID == reservedKind {
			problems = append(problems, kindReserved)
		}
		if dynvalue.Trim(kind.Label) == "" {
			problems = append(problems, "У типа "+kind.ID+" нет подписи.")
		}
		if !dirSlugPattern.MatchString(kind.Dir) {
			problems = append(problems, "Папка типа "+kind.ID+": латиница, цифры, дефис и подчёркивание.")
		}
		if ids[kind.ID] {
			problems = append(problems, "Код типа повторяется: "+kind.ID+".")
		}
		if dirs[kind.Dir] {
			problems = append(problems, "Папка повторяется: "+kind.Dir+".")
		}
		ids[kind.ID], dirs[kind.Dir] = true, true
	}
	return problems
}

// ValidateReferences проверяет коды, названия, известный тип и изображения референсов.
func ValidateReferences(references []ReferenceInput, kinds []Kind) []string {
	problems := []string{}
	known := map[string]bool{}
	for _, kind := range kinds {
		known[kind.ID] = true
	}
	seen := map[string]bool{}
	for _, ref := range references {
		label := ref.Name
		if label == "" {
			label = ref.ID
		}
		if label == "" {
			label = unnamedReference
		}
		if !slugPattern.MatchString(ref.ID) {
			problems = append(problems, "Код референса «"+label+"»: латиница в нижнем регистре, цифры и подчёркивание, начиная с буквы.")
		}
		if seen[ref.ID] {
			problems = append(problems, "Код референса повторяется: "+ref.ID+".")
		}
		seen[ref.ID] = true
		if dynvalue.Trim(ref.Name) == "" {
			problems = append(problems, "У референса "+ref.ID+" нет названия.")
		}
		if !known[ref.Kind] {
			problems = append(problems, "У референса "+ref.ID+" неизвестный тип "+ref.Kind+": добавьте тип в список типов.")
		}
		if len(ref.Files) == 0 {
			problems = append(problems, "У референса "+ref.ID+" нет ни одного изображения.")
		}
		for _, file := range ref.Files {
			// sourcePath ?? existingPath: пустая строка не заменяется сохранённым путём.
			source := file.SourcePath
			if source == nil {
				source = file.ExistingPath
			}
			switch {
			case source == nil || *source == "":
				problems = append(problems, "У референса "+ref.ID+" файл без пути.")
			case file.SourcePath != nil && *file.SourcePath != "" && !imageExtensions[strings.ToLower(extname(*file.SourcePath))]:
				problems = append(problems, "Референс "+ref.ID+": допустимы PNG, JPG и WebP, получен "+dynvalue.Basename(*file.SourcePath)+".")
			case file.SourcePath != nil && *file.SourcePath != "" && !dynvalue.Exists(*file.SourcePath):
				problems = append(problems, "Референс "+ref.ID+": файл не найден: "+*file.SourcePath+".")
			}
		}
	}
	return problems
}

// readText — содержимое текстового файла или "", если его нет.
func readText(path string) (string, error) {
	if !dynvalue.Exists(path) {
		return "", nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", dynvalue.FsError("open", path, err)
	}
	return dynvalue.DecodeUTF8(data), nil
}

// pathOf — строковое поле path описи или TypeError dynvalue.PathArg на нестроковом пути.
func pathOf(file any) (string, error) {
	return dynvalue.PathArg("path", dynvalue.Get(file, "path"))
}

// ViewProject — sources.view: опись, тексты и абсолютные пути изображений. Ничего не пишет.
// Проблемы: отсутствующие файлы описи и непригодная опись (не схема 1 или битый JSON).
func ViewProject(project string) (View, error) {
	manifest := sources.ReadManifest(project)
	source := filepath.Join(project, sourceDir)
	view := View{Manifest: json.RawMessage("null"), ReferenceFilePaths: map[string]string{}, Problems: []string{},
		PinnedReferences: map[string][]string{}, EntityKinds: map[string]string{}}
	if manifest != nil {
		view.Manifest = dynvalue.Raw(manifest)
		check := func(file any, label string) error {
			if !dynvalue.Truthy(file) {
				return nil
			}
			path, err := pathOf(file)
			if err != nil {
				return err
			}
			if !dynvalue.Exists(filepath.Join(source, path)) {
				view.Problems = append(view.Problems, fmt.Sprintf(manifestFileMissingFn, label, path))
			}
			return nil
		}
		for _, part := range []struct{ key, label string }{{"track", trackLabel}, {"lyrics", lyricsLabel}, {"idea", ideaLabel}, {"cover", coverLabel}} {
			if err := check(dynvalue.Get(manifest, part.key), part.label); err != nil {
				return View{}, err
			}
		}
		references, err := dynvalue.Iterate(dynvalue.Get(manifest, "references"))
		if err != nil {
			return View{}, err
		}
		for _, ref := range references {
			files, err := dynvalue.Iterate(dynvalue.Get(ref, "files"))
			if err != nil {
				return View{}, err
			}
			for _, file := range files {
				if err := check(file, referenceLabelPrefix+dynvalue.ToString(dynvalue.Get(ref, "id"))); err != nil {
					return View{}, err
				}
				path, err := pathOf(file)
				if err != nil {
					return View{}, err
				}
				view.ReferenceFilePaths[path] = filepath.Join(source, path)
			}
		}
	} else if dynvalue.Exists(filepath.Join(source, manifestName)) {
		view.Problems = append(view.Problems, sources.ManifestInvalid)
	}
	var err error
	if view.LyricsText, err = readText(filepath.Join(source, manifestPath(manifest, "lyrics", lyricsName))); err != nil {
		return View{}, err
	}
	if view.IdeaText, err = readText(filepath.Join(source, manifestPath(manifest, "idea", ideaName))); err != nil {
		return View{}, err
	}
	if cover := dynvalue.Get(manifest, "cover"); dynvalue.Truthy(cover) {
		path, err := pathOf(cover)
		if err != nil {
			return View{}, err
		}
		absolute := filepath.Join(source, path)
		view.CoverPath = &absolute
	}
	return view, nil
}

// manifestPath — строковый путь manifest[key].path или fallback.
func manifestPath(manifest any, key, fallback string) string {
	if path, ok := dynvalue.GetPath(manifest, key, "path").(string); ok {
		return path
	}
	return fallback
}

// Validate — sources.validate: ввод проверяется с учётом уже сохранённого (обязательные части
// новые либо сохранённые); тот же разбор текста применяется к вводу, импорту и сохранённому тексту.
func Validate(project string, input Input) ([]string, error) {
	existing := sources.ReadManifest(project)
	problems := []string{}
	if input.Track == nil && !dynvalue.Truthy(dynvalue.Get(existing, "track")) {
		problems = append(problems, trackRequired)
	}
	if input.Track != nil {
		if !dynvalue.Exists(input.Track.Path) {
			problems = append(problems, "Файл трека не найден: "+input.Track.Path)
		} else if strings.ToLower(extname(input.Track.Path)) != ".mp3" {
			problems = append(problems, trackFormatInvalid)
		}
	}
	textProblem := func(value *TextInput, saved any, label, required string) {
		if value == nil && !dynvalue.Truthy(saved) {
			problems = append(problems, required)
		}
		if value != nil && value.Path != nil && !dynvalue.Exists(*value.Path) {
			problems = append(problems, label+": файл не найден: "+*value.Path)
		}
		if value != nil && value.Text != nil && dynvalue.Trim(*value.Text) == "" {
			problems = append(problems, label+": пустой текст.")
		}
	}
	textProblem(input.Lyrics, dynvalue.Get(existing, "lyrics"), lyricsLabel, lyricsRequired)
	textProblem(input.Idea, dynvalue.Get(existing, "idea"), clipIdeaLabel, ideaRequired)
	lyricsText, hasLyrics, err := lyricsForCheck(project, input.Lyrics, existing)
	if err != nil {
		return nil, err
	}
	if hasLyrics {
		problems = append(problems, timing.AnalyzeLyrics(lyricsText).Problems...)
	}
	if input.Cover != nil && input.Cover.Path != nil {
		if !dynvalue.Exists(*input.Cover.Path) {
			problems = append(problems, "Файл обложки не найден: "+*input.Cover.Path)
		} else if !imageExtensions[strings.ToLower(extname(*input.Cover.Path))] {
			problems = append(problems, coverFormatInvalid)
		}
	}
	kinds, _ := resolveKinds(&input, existing)
	problems = append(problems, ValidateKinds(kinds)...)
	problems = append(problems, ValidateReferences(input.References, kinds)...)
	return problems, nil
}

// lyricsForCheck — текст песни для разбора: введённый, из выбранного файла или сохранённый.
func lyricsForCheck(project string, input *TextInput, existing any) (string, bool, error) {
	// Для разбора введённый текст важнее пути: если есть ключ text, берётся он.
	if input != nil && input.Text != nil {
		return *input.Text, true, nil
	}
	path := ""
	if input != nil && input.Path != nil {
		path = *input.Path
	} else if saved := dynvalue.Get(existing, "lyrics"); dynvalue.Truthy(saved) {
		relative, err := pathOf(saved)
		if err != nil {
			return "", false, err
		}
		path = filepath.Join(project, sourceDir, relative)
	}
	if path == "" || !dynvalue.Exists(path) {
		return "", false, nil
	}
	data, err := os.ReadFile(path)
	if err != nil {
		return "", false, dynvalue.FsError("open", path, err)
	}
	return dynvalue.DecodeUTF8(data), true, nil
}

// normalizeText — переносы строк LF, без пробелов в конце, ровно один перевод строки в конце.
func normalizeText(text string) string {
	text = strings.ReplaceAll(text, "\r\n", "\n")
	return strings.TrimRightFunc(text, func(char rune) bool { return dynvalue.Trim(string(char)) == "" }) + "\n"
}

// textFrom — содержимое файла или введённый текст.
func textFrom(value *TextInput) (string, error) {
	if value.Path != nil {
		data, err := os.ReadFile(*value.Path)
		if err != nil {
			return "", dynvalue.FsError("open", *value.Path, err)
		}
		return dynvalue.DecodeUTF8(data), nil
	}
	return *value.Text, nil
}

// DurationProbe — путь ffprobe для длительности трека; пустой — FFmpeg не найден, длительность null.
type DurationProbe string

// probe — длительность в секундах с точностью до миллисекунды или nil.
// Отсутствие или сбой ffprobe не блокирует сохранение исходников.
func (p DurationProbe) probe(ctx context.Context, path string) any {
	if p == "" {
		return nil
	}
	result, err := process.Run(ctx, process.Command{
		Path: string(p), Name: "ffprobe", StdoutLimit: 4096, StderrLimit: 4096,
		Args: []string{"-v", "error", "-show_entries", "format=duration", "-of", "default=nw=1:nk=1", path},
	})
	if err != nil {
		return nil
	}
	value, ok := parseFloat(strings.TrimSpace(string(result.Stdout)))
	if !ok || math.IsInf(value, 0) {
		return nil
	}
	// Округление до тысячных: половина округляется вверх.
	return math.Floor(value*1000+0.5) / 1000
}

// floatPrefix — числовой префикс строки (знак, цифры с точкой, экспонента); хвост после него игнорируется.
var floatPrefix = regexp.MustCompile(`^[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?`)

func parseFloat(text string) (float64, bool) {
	match := floatPrefix.FindString(text)
	if match == "" {
		return 0, false
	}
	value, err := strconv.ParseFloat(match, 64)
	return value, err == nil
}

// describe — {path, sha256, bytes} файла внутри source; путь всегда через «/».
func describe(source, relative string) (*dynvalue.Object, error) {
	full := filepath.Join(source, filepath.FromSlash(relative))
	file, err := os.Open(full)
	if err != nil {
		return nil, dynvalue.FsError("open", full, err)
	}
	defer file.Close()
	hash := sha256.New()
	size, err := io.Copy(hash, file)
	if err != nil {
		return nil, err
	}
	object := dynvalue.NewObject()
	object.Set("path", strings.ReplaceAll(relative, "\\", "/"))
	object.Set("sha256", hex.EncodeToString(hash.Sum(nil)))
	object.Set("bytes", float64(size))
	return object, nil
}

// fileMode — права для замены: прежние у существующего файла, иначе 0666 с учётом umask.
// Копирование переносит права источника, это решает вызывающий.
func fileMode(path string) os.FileMode {
	if info, err := os.Stat(path); err == nil {
		return info.Mode().Perm()
	}
	return 0o666
}

// writeText атомарно записывает текст в UTF-8.
func writeText(path, text string) error {
	return replaceFile(path, fileMode(path), func(target io.Writer) error {
		_, err := io.WriteString(target, text)
		return err
	})
}

// copyFile — копирование с атомарной заменой: содержимое и права источника, поток без чтения в память.
func copyFile(from, to string) error {
	source, err := os.Open(from)
	if err != nil {
		return dynvalue.FsError("copyfile", from, err)
	}
	defer source.Close()
	mode := os.FileMode(0o666)
	if info, err := source.Stat(); err == nil {
		mode = info.Mode().Perm()
	}
	return replaceFile(to, mode, func(target io.Writer) error {
		_, err := io.Copy(target, source)
		return err
	})
}

// replaceFile пишет во временный файл в той же папке, сбрасывает его на диск и переименовывает
// поверх цели: сбой оставляет прежний файл целым. Права нового файла проходят через umask.
func replaceFile(path string, mode os.FileMode, fill func(io.Writer) error) error {
	suffix := make([]byte, 8)
	if _, err := rand.Read(suffix); err != nil {
		return fmt.Errorf("Не удалось сохранить %s: %w", path, err)
	}
	name := filepath.Join(filepath.Dir(path), "."+filepath.Base(path)+"."+hex.EncodeToString(suffix)+".tmp")
	temporary, err := os.OpenFile(name, os.O_WRONLY|os.O_CREATE|os.O_EXCL, mode)
	if err != nil {
		return fmt.Errorf("Не удалось сохранить %s: %w", path, err)
	}
	defer os.Remove(name)
	err = fill(temporary)
	if err == nil {
		err = temporary.Sync()
	}
	if closeErr := temporary.Close(); err == nil {
		err = closeErr
	}
	if err == nil {
		err = os.Rename(name, path)
	}
	if err != nil {
		return fmt.Errorf("Не удалось сохранить %s: %w", path, err)
	}
	return nil
}

// removeLocal удаляет source/rel, если он есть, только для путей внутри source:
// повреждённая опись с «..» не удаляет файлы вне папки исходников.
func removeLocal(source, relative string) error {
	local := filepath.FromSlash(relative)
	if !filepath.IsLocal(local) {
		return nil
	}
	if err := os.Remove(filepath.Join(source, local)); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

// stringValue — значение, если это строка, иначе "".
func stringValue(value any) string {
	text, _ := value.(string)
	return text
}

// orNull — `value ?? null` для полей описи.
func orNull(value any) any {
	if dynvalue.IsNullish(value) {
		return nil
	}
	return value
}

// Save — сохранение без кастинга: проверяет ввод, копирует новые файлы,
// пишет тексты и промпты и записывает опись. Новые файлы копируются, прежние остаются; изображения и
// промпты, исчезнувшие из ввода, удаляются, только если они перечислены в прежней описи. ffprobe —
// путь для длительности. Сервис sources.save вызывает его через internal/referenceimage, который
// при существующем plan/cast.json синхронизирует кастинг.
//
// Ошибка проверки — проблемы через пробел, без записи. Сбой посреди записи оставляет каждый
// файл целым (старым или новым); опись пишется последней.
func Save(ctx context.Context, project string, input Input, ffprobe DurationProbe) (json.RawMessage, error) {
	manifest, _, err := SaveManifest(ctx, project, input, ffprobe, SaveOptions{})
	if err != nil {
		return nil, err
	}
	return dynvalue.Raw(manifest), nil
}

// SaveOptions — необязательные параметры SaveManifest.
type SaveOptions struct {
	// BeforeWrite (может быть nil) вызывается после проверки ввода и шлюза записи, непосредственно
	// перед первой записью в source/; его ошибка прерывает сохранение без записи. Так вызывающий
	// делает резервную копию только для сохранения, которое действительно начнёт писать.
	BeforeWrite func() error
	// Pinned — коды референсов, чьи сохранённые файлы не переносятся в папку нового типа: их
	// используют планы с готовыми материалами, и смена пути сделала бы эти материалы устаревшими.
	Pinned map[string]bool
}

// SaveManifest — Save, возвращающий записанную опись деревом dynvalue (её читает синхронизация
// кастинга без повторного разбора файла) и перенесённые файлы: прежний путь → новый, оба внутри
// source/. Кастинг ссылается на изображения этими путями, поэтому вызывающий заменяет их у себя.
//
// Все записи Save заменяют файлы через rename (replaceFile) или удаляют их, но никогда не пишут в
// существующий файл на месте: на этом держится резерв жёсткими ссылками в internal/referenceimage.
// Перенос тоже копирует файл на новое место, а прежний удаляет cleanup.
func SaveManifest(ctx context.Context, project string, input Input, ffprobe DurationProbe, options SaveOptions) (*dynvalue.Object, map[string]string, error) {
	problems, err := Validate(project, input)
	if err != nil {
		return nil, nil, err
	}
	if len(problems) > 0 {
		return nil, nil, errors.New(strings.Join(problems, " "))
	}
	if err := projectfs.CheckWrite(project); err != nil {
		return nil, nil, err
	}
	if options.BeforeWrite != nil {
		if err := options.BeforeWrite(); err != nil {
			return nil, nil, err
		}
	}
	previous := sources.ReadManifest(project)
	kinds, kindsJSON := resolveKinds(&input, previous)
	dirOf := map[string]string{}
	for _, kind := range kinds {
		dirOf[kind.ID] = kind.Dir
	}
	source := filepath.Join(project, sourceDir)
	if err := os.MkdirAll(source, 0o777); err != nil {
		return nil, nil, err
	}
	s := &saver{ctx: ctx, source: source, keep: map[string]bool{}, pinned: options.Pinned, moves: map[string]string{}}

	track := orNull(dynvalue.Get(previous, "track"))
	if input.Track != nil {
		if err := copyFile(input.Track.Path, filepath.Join(source, trackName)); err != nil {
			return nil, nil, err
		}
		described, err := describe(source, trackName)
		if err != nil {
			return nil, nil, err
		}
		described.Set("original_name", dynvalue.Basename(input.Track.Path))
		described.Set("duration_seconds", ffprobe.probe(ctx, filepath.Join(source, trackName)))
		track = described
	}
	lyrics := orNull(dynvalue.Get(previous, "lyrics"))
	if input.Lyrics != nil {
		text, err := textFrom(input.Lyrics)
		if err != nil {
			return nil, nil, err
		}
		text = normalizeText(text)
		if err := writeText(filepath.Join(source, lyricsName), text); err != nil {
			return nil, nil, err
		}
		parsed := timing.AnalyzeLyrics(text)
		described, err := describe(source, lyricsName)
		if err != nil {
			return nil, nil, err
		}
		described.Set("lines", float64(parsed.Lines))
		sections := make([]any, 0, len(parsed.Sections))
		for _, section := range parsed.Sections {
			sections = append(sections, section)
		}
		described.Set("sections", &dynvalue.Array{Items: sections})
		lyrics = described
	}
	idea := orNull(dynvalue.Get(previous, "idea"))
	if input.Idea != nil {
		text, err := textFrom(input.Idea)
		if err != nil {
			return nil, nil, err
		}
		if err := writeText(filepath.Join(source, ideaName), normalizeText(text)); err != nil {
			return nil, nil, err
		}
		if idea, err = describe(source, ideaName); err != nil {
			return nil, nil, err
		}
	}
	cover := orNull(dynvalue.Get(previous, "cover"))
	if input.Cover != nil && (input.Cover.Remove != nil || input.Cover.Path != nil) {
		if cover != nil {
			path, err := pathOf(cover)
			if err != nil {
				return nil, nil, err
			}
			if err := removeLocal(source, path); err != nil {
				return nil, nil, err
			}
		}
		cover = nil
		if input.Cover.Remove == nil {
			name := "cover" + strings.ToLower(extname(*input.Cover.Path))
			if err := copyFile(*input.Cover.Path, filepath.Join(source, name)); err != nil {
				return nil, nil, err
			}
			if cover, err = describe(source, name); err != nil {
				return nil, nil, err
			}
		}
	}

	references, err := s.references(input.References, previous, dirOf)
	if err != nil {
		return nil, nil, err
	}
	if err := s.cleanup(previous, kinds); err != nil {
		return nil, nil, err
	}

	manifest := dynvalue.NewObject()
	manifest.Set("schema_version", 1.0)
	manifest.Set("kinds", kindsJSON)
	manifest.Set("track", track)
	manifest.Set("lyrics", lyrics)
	manifest.Set("idea", idea)
	manifest.Set("cover", cover)
	manifest.Set("references", references)
	manifest.Set("updated_at", time.Now().UTC().Format("2006-01-02T15:04:05.000Z"))
	if err := writeText(filepath.Join(source, manifestName), dynvalue.StringifyIndent(manifest, "  ")+"\n"); err != nil {
		return nil, nil, err
	}
	return manifest, s.moves, nil
}

// saver хранит состояние одного сохранения: keep — пути внутри source, которые остаются в новой
// описи (изображения и промпты); всё остальное из прежней описи удаляется в cleanup.
//
// pinned — коды референсов, файлы которых остаются на месте (SaveOptions.Pinned); moves —
// перенесённые в этом сохранении файлы: прежний путь → новый.
type saver struct {
	ctx    context.Context
	source string
	keep   map[string]bool
	pinned map[string]bool
	moves  map[string]string
}

// savePrompt пишет промпт, только если текст изменился (сравнение после нормализации).
func (s *saver) savePrompt(relative, text string) error {
	path := filepath.Join(s.source, filepath.FromSlash(relative))
	current, err := readText(path)
	if err != nil {
		return err
	}
	if !dynvalue.Exists(path) || normalizeText(current) != normalizeText(text) {
		if err := writeText(path, normalizeText(text)); err != nil {
			return err
		}
	}
	s.keep[relative] = true
	return nil
}

// fileKey связывает файл ввода с его вычисленным путём: индекс референса и изображения.
type fileKey struct{ ref, file int }

// references строит референсы новой описи. Порядок шагов важен: сначала имена
// новых изображений (без занятых путей), затем пути промптов, которые перезапишутся, и только
// потом запись — общий старый путь промпта может требоваться другому виду без изменений.
func (s *saver) references(inputs []ReferenceInput, previous any, dirOf map[string]string) (*dynvalue.Array, error) {
	previousRefs, _ := dynvalue.AsArray(dynvalue.Get(previous, "references"))
	previousFiles := map[string]any{}
	for _, ref := range previousRefs {
		files, _ := dynvalue.AsArray(dynvalue.Get(ref, "files"))
		for _, file := range files {
			previousFiles[dynvalue.ToString(dynvalue.Get(file, "path"))] = file
		}
	}
	previousFilePrompts := map[string]string{}
	for _, file := range previousFiles {
		if prompt := stringValue(dynvalue.Get(file, "prompt")); prompt != "" {
			text, err := readText(filepath.Join(s.source, filepath.FromSlash(prompt)))
			if err != nil {
				return nil, err
			}
			previousFilePrompts[prompt] = text
		}
	}
	promptOf := func(file FileInput) string {
		if file.ExistingPath == nil || *file.ExistingPath == "" {
			return ""
		}
		return stringValue(dynvalue.Get(previousFiles[*file.ExistingPath], "prompt"))
	}

	imagePaths := map[fileKey]string{}
	occupied := map[string]bool{}
	for _, ref := range inputs {
		for _, file := range ref.Files {
			if file.ExistingPath != nil && *file.ExistingPath != "" {
				occupied[*file.ExistingPath] = true
			}
		}
	}
	// После удаления первого вида его сосед может сохранить имя «-2»: новый файл не должен его перезаписать.
	for r, ref := range inputs {
		for f, file := range ref.Files {
			if file.ExistingPath != nil && *file.ExistingPath != "" {
				imagePaths[fileKey{r, f}] = s.placeExisting(ref, *file.ExistingPath, dirOf[ref.Kind], occupied)
				continue
			}
			extension := strings.ToLower(extname(*file.SourcePath))
			if extension == ".jpeg" {
				extension = ".jpg"
			}
			suffix := f
			name := func() string {
				if suffix == 0 {
					return dirOf[ref.Kind] + "/" + ref.ID + extension
				}
				return dirOf[ref.Kind] + "/" + ref.ID + "-" + strconv.Itoa(suffix+1) + extension
			}
			relative := name()
			for occupied[relative] {
				suffix++
				relative = name()
			}
			occupied[relative] = true
			imagePaths[fileKey{r, f}] = relative
		}
	}
	changedPromptPaths := map[string]bool{}
	for r, ref := range inputs {
		for f, file := range ref.Files {
			if file.Prompt == nil || dynvalue.Trim(*file.Prompt) == "" {
				continue
			}
			old := promptOf(file)
			if old == "" || normalizeText(previousFilePrompts[old]) != normalizeText(*file.Prompt) {
				changedPromptPaths[imagePaths[fileKey{r, f}]+".prompt.txt"] = true
			}
		}
	}
	// Общие промпты читаются до записи: прежний произвольный путь может совпасть с новым промптом изображения.
	type commonPrompt struct {
		path string
		text string
	}
	previousPrompts := map[string]commonPrompt{}
	for _, ref := range previousRefs {
		path := stringValue(dynvalue.Get(ref, "prompt"))
		text := ""
		if path != "" {
			var err error
			if text, err = readText(filepath.Join(s.source, filepath.FromSlash(path))); err != nil {
				return nil, err
			}
		}
		previousPrompts[dynvalue.ToString(dynvalue.Get(ref, "id"))] = commonPrompt{path: path, text: text}
	}

	result := make([]*dynvalue.Object, 0, len(inputs))
	for r, ref := range inputs {
		dir := dirOf[ref.Kind]
		if err := os.MkdirAll(filepath.Join(s.source, filepath.FromSlash(dir)), 0o777); err != nil {
			return nil, err
		}
		files := make([]any, 0, len(ref.Files))
		for f, file := range ref.Files {
			relative := imagePaths[fileKey{r, f}]
			moved := false
			if file.ExistingPath == nil || *file.ExistingPath == "" {
				target := filepath.Join(s.source, filepath.FromSlash(relative))
				if dynvalue.Resolve("", *file.SourcePath) != dynvalue.Resolve("", target) {
					if err := copyFile(*file.SourcePath, target); err != nil {
						return nil, err
					}
				}
			} else if moved = relative != *file.ExistingPath; moved {
				// Прежний файл удалит cleanup: его пути нет в keep.
				if err := copyFile(filepath.Join(s.source, filepath.FromSlash(*file.ExistingPath)), filepath.Join(s.source, filepath.FromSlash(relative))); err != nil {
					return nil, err
				}
			}
			s.keep[relative] = true
			previousPrompt := promptOf(file)
			// Запрос без поля prompt не удаляет уже сохранённый промпт изображения.
			unchanged := previousPrompt != "" && (file.Prompt == nil ||
				(dynvalue.Trim(*file.Prompt) != "" && normalizeText(*file.Prompt) == normalizeText(previousFilePrompts[previousPrompt])))
			var prompt any
			switch {
			case unchanged:
				prompt = previousPrompt
			case file.Prompt != nil && dynvalue.Trim(*file.Prompt) != "":
				prompt = relative + ".prompt.txt"
			}
			if path, ok := prompt.(string); ok {
				if unchanged && (changedPromptPaths[path] || moved) {
					// Другой вид перезапишет общий путь или изображение переехало в папку нового типа: прежние
					// точные байты остаются под собственным именем изображения.
					path = relative + ".prompt.txt"
					prompt = path
					if err := writeText(filepath.Join(s.source, filepath.FromSlash(path)), previousFilePrompts[previousPrompt]); err != nil {
						return nil, err
					}
				} else if !unchanged && file.Prompt != nil {
					if err := s.savePrompt(path, *file.Prompt); err != nil {
						return nil, err
					}
				}
				s.keep[path] = true
			}
			described, err := describe(s.source, relative)
			if err != nil {
				return nil, err
			}
			if file.View != nil {
				described.Set("view", *file.View)
			}
			described.Set("note", dynvalue.Trim(file.Note))
			described.Set("prompt", prompt)
			files = append(files, described)
		}
		name := dynvalue.Trim(ref.Name)
		short := dynvalue.Trim(ref.ShortName)
		if short == "" {
			short = name
		}
		object := dynvalue.NewObject()
		object.Set("id", ref.ID)
		object.Set("kind", ref.Kind)
		object.Set("name", name)
		object.Set("short_name", short)
		object.Set("description", dynvalue.Trim(ref.Description))
		object.Set("files", &dynvalue.Array{Items: files})
		object.Set("prompt", nil)
		result = append(result, object)
	}
	// Общий промпт остаётся отдельным документом и не назначается изображениям.
	for index, object := range result {
		text := inputs[index].Prompt
		if dynvalue.Trim(text) == "" {
			continue
		}
		ref := inputs[index]
		old, hasOld := previousPrompts[ref.ID]
		dir := dirOf[ref.Kind]
		prompt := dir + "/" + ref.ID + ".prompt.txt"
		// Общий промпт переезжает вместе с изображениями, если референс не закреплён производством.
		if hasOld && old.path != "" && normalizeText(old.text) == normalizeText(text) && !s.keep[old.path] &&
			(s.pinned[ref.ID] || path.Dir(old.path) == dir) {
			prompt = old.path
		}
		// Нестандартный старый путь может быть занят изображением или его промптом: сохраняются оба документа.
		for suffix := 0; s.keep[prompt]; suffix++ {
			prompt = dir + "/" + ref.ID + ".common"
			if suffix > 0 {
				prompt += "-" + strconv.Itoa(suffix+1)
			}
			prompt += ".prompt.txt"
		}
		if hasOld && old.path == prompt && normalizeText(old.text) == normalizeText(text) {
			s.keep[prompt] = true
		} else if err := s.savePrompt(prompt, text); err != nil {
			return nil, err
		}
		object.Set("prompt", prompt)
	}
	items := make([]any, 0, len(result))
	for _, object := range result {
		items = append(items, object)
	}
	return &dynvalue.Array{Items: items}, nil
}

// placeExisting — путь сохранённого изображения в новой описи. Файл переносится в папку типа
// референса, если лежит в другой (тип сменили) и референс не закреплён производством: имя
// сохраняется, при занятом пути добавляется суффикс «-2», «-3»… Занятым считается путь описи,
// уже выбранный путь этого сохранения или любой файл на диске — чужой файл не перезаписывается.
// Перенос запоминается в moves; сам файл копирует references.
func (s *saver) placeExisting(ref ReferenceInput, existing, dir string, occupied map[string]bool) string {
	if s.pinned[ref.ID] || dir == "" || path.Dir(existing) == dir {
		return existing
	}
	base := path.Base(existing)
	extension := path.Ext(base)
	stem := strings.TrimSuffix(base, extension)
	relative := dir + "/" + base
	for suffix := 2; occupied[relative] || dynvalue.Exists(filepath.Join(s.source, filepath.FromSlash(relative))); suffix++ {
		relative = dir + "/" + stem + "-" + strconv.Itoa(suffix) + extension
	}
	occupied[relative] = true
	s.moves[existing] = relative
	return relative
}

// cleanup удаляет изображения и промпты прежней описи, которых нет в новой, и пустые папки
// типов без .gitkeep (папки шаблона с меткой остаются).
func (s *saver) cleanup(previous any, kinds []Kind) error {
	previousRefs, _ := dynvalue.AsArray(dynvalue.Get(previous, "references"))
	for _, ref := range previousRefs {
		files, _ := dynvalue.AsArray(dynvalue.Get(ref, "files"))
		for _, file := range files {
			if path := stringValue(dynvalue.Get(file, "path")); !s.keep[path] {
				if err := removeLocal(s.source, path); err != nil {
					return err
				}
			}
			if prompt := stringValue(dynvalue.Get(file, "prompt")); prompt != "" && !s.keep[prompt] {
				if err := removeLocal(s.source, prompt); err != nil {
					return err
				}
			}
		}
		if prompt := stringValue(dynvalue.Get(ref, "prompt")); prompt != "" && !s.keep[prompt] {
			if err := removeLocal(s.source, prompt); err != nil {
				return err
			}
		}
	}
	previousKinds, ok := manifestKinds(previous)
	if !ok {
		previousKinds = DefaultKinds
	}
	seen := map[string]bool{}
	for _, kind := range append(append([]Kind{}, kinds...), previousKinds...) {
		if seen[kind.Dir] {
			continue
		}
		seen[kind.Dir] = true
		full := filepath.Join(s.source, filepath.FromSlash(kind.Dir))
		entries, err := os.ReadDir(full)
		if err != nil || len(entries) > 0 || !filepath.IsLocal(filepath.FromSlash(kind.Dir)) {
			continue
		}
		if err := os.Remove(full); err != nil && !errors.Is(err, os.ErrNotExist) {
			return err
		}
	}
	return nil
}
