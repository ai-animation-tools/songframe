// Package sceneregistry проверяет реестр сцен и проект для инструментов tools.run: единственный
// источник постановки и монтажного времени инструментов. Пакет проверяет plan/project.json и
// plan/scenes.json, разворачивает сюжетные состояния планов, считает отпечатки постановки,
// свежесть принятых комплектов и монтажное время планов.
//
// Пакет — общая основа инструментов scene_scaffold, lint_registry, check_assets, check_workspace и
// shot_status. Их вывод зафиксирован эталонами, поэтому значения — модель toolrt (различие
// целых и дробных, порядок ключей), а ошибки — исключения *toolrt.Exception: инструмент печатает
// текст исключения и выбирает код завершения по его типу.
//
// Устройство:
//   - начальное состояние сущностей передаётся явно (initial): вызывающий получает его через
//     InitialStatesFor(root). Кэша по проекту нет: каждый вызов читает кастинг заново, поэтому
//     долгоживущий процесс приложения не видит устаревших данных;
//   - хеши роликов кэширует internal/filedigest по идентичности файла.
//
// Страницы приложения используют internal/scenario и internal/acceptance: они принимают и
// проверяют данные в модели dynvalue, которая в краевых случаях отличается от toolrt (см.
// testdata/golden/README.md, домен scene-registry).
package sceneregistry

import (
	"path/filepath"
	"regexp"
	"strings"

	"songframe/internal/projectfile"
	"songframe/internal/toolrt"
)

// Пути внутри проекта.
const (
	ProjectPath      = "plan/project.json"
	ScenesPath       = "plan/scenes.json"
	ProductionStatus = "plan/production-status.json"
)

// Регулярные выражения проверок. Цифры кодов — любые десятичные цифры Unicode, поэтому \p{Nd}.
var (
	// ShotID — код плана Mxx или Mxx.n.
	ShotID = regexp.MustCompile(`^M\p{Nd}{2}(?:\.\p{Nd}+)?$`)
	// SHA256 — hex-отпечаток в нижнем регистре.
	SHA256       = regexp.MustCompile(`^[0-9a-f]{64}$`)
	slug         = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	mp4Name      = regexp.MustCompile(`^[\p{L}\p{N}_.-]+\.mp4$`)
	aspectRatio  = regexp.MustCompile(`^\p{Nd}+:\p{Nd}+$`)
	newlineChars = "\r\n"
)

// fullmatch — совпадение pattern со всей строкой value; не-строка — TypeError.
func fullmatch(pattern *regexp.Regexp, value any) (bool, error) {
	text, ok := value.(string)
	if !ok {
		return false, toolrt.Raise(toolrt.TypeError, "ожидается строка, получено: %s", toolrt.TypeName(value))
	}
	return pattern.MatchString(text), nil
}

// valueError — ValueError с форматированным текстом.
func valueError(format string, args ...any) error {
	return toolrt.Raise(toolrt.ValueError, format, args...)
}

// GenerationFields — обязательные поля generation.video и их типы.
var GenerationFields = []string{"provider", "resolution", "aspect_ratio", "watermark", "duration_rule"}

// DurationRules — допустимые правила длительности видео.
var DurationRules = []string{"min_supported_strictly_greater_than_window", "min_supported_not_less_than_window", "exact_window"}

// FrameRate — fps входит в допустимые частоты проекта (projectfile.FrameRates).
func FrameRate(fps toolrt.Int) bool {
	value, fits := fps.Int64()
	return fits && projectfile.ValidFrameRate(int(value))
}

// ProjectFPS — частота кадров проекта root из проверенного plan/project.json.
func ProjectFPS(root string) (toolrt.Int, error) {
	document, err := LoadProject(root, false)
	if err != nil {
		return toolrt.Int{}, err
	}
	return document.Value("fps").(toolrt.Int), nil
}

// ValidateProject — схема, название без переводов строк, имя MP4 аниматика, частота кадров fps,
// строковые agent_instructions и, если validateGeneration, независимые блоки generation.video и
// generation.image (GenerationSettings). Возвращает тот же документ.
func ValidateProject(data any, validateGeneration bool) (*toolrt.Dict, error) {
	document, ok := data.(*toolrt.Dict)
	name, isString := document.Value("name").(string)
	if !ok || !toolrt.Equal(document.Value("schema_version"), toolrt.NewInt(1)) || !isString ||
		toolrt.Strip(name) == "" || strings.ContainsAny(name, newlineChars) {
		return nil, valueError("В plan/project.json нужны схема и непустое название проекта.")
	}
	filename, isString := document.Value("animatic_video").(string)
	if !isString || !mp4Name.MatchString(filename) || strings.HasPrefix(filename, ".") {
		return nil, valueError("animatic_video должен быть именем MP4 без пути к папке.")
	}
	if fps, isInt := document.Value("fps").(toolrt.Int); !isInt || !FrameRate(fps) {
		return nil, valueError(projectfile.FrameRateInvalid)
	}
	if value, ok := document.Get("agent_instructions"); ok {
		if _, isString := value.(string); !isString {
			return nil, valueError("plan/project.json: agent_instructions должен быть строкой.")
		}
	}
	generation := document.Value("generation")
	if validateGeneration && generation != nil {
		block, ok := generation.(*toolrt.Dict)
		if !ok {
			return nil, valueError("generation должен быть объектом настроек.")
		}
		if !block.Has("video") && !block.Has("image") {
			return nil, valueError("В generation нужны независимые блоки video и image.")
		}
		for _, kind := range []string{"video", "image"} {
			if block.Value(kind) != nil {
				if _, err := GenerationSettings(document, kind); err != nil {
					return nil, err
				}
			}
		}
	}
	return document, nil
}

// GenerationSettings — копия проверенного блока generation.video
// или generation.image без изменения данных проекта.
func GenerationSettings(data any, kind string) (*toolrt.Dict, error) {
	if kind != "video" && kind != "image" {
		return nil, valueError("Вид генерации должен быть video или image.")
	}
	var generation *toolrt.Dict
	if document, ok := data.(*toolrt.Dict); ok {
		generation, _ = document.Value("generation").(*toolrt.Dict)
	}
	if generation == nil {
		return nil, valueError("В plan/project.json нет блока generation.%s.", kind)
	}
	block, ok := generation.Value(kind).(*toolrt.Dict)
	if !ok {
		return nil, valueError("В plan/project.json нет корректного блока generation.%s.", kind)
	}
	fields := []string{"provider"}
	if kind == "video" {
		fields = GenerationFields
	}
	missing := []string{}
	for _, key := range fields {
		value := block.Value(key)
		if key == "watermark" {
			if _, isBool := value.(bool); !isBool {
				missing = append(missing, key)
			}
			continue
		}
		if text, isString := value.(string); !isString || toolrt.Strip(text) == "" {
			missing = append(missing, key)
		}
	}
	if len(missing) > 0 {
		return nil, valueError("В generation.%s не заполнены поля: %s.", kind, strings.Join(missing, ", "))
	}
	if kind == "video" {
		rule := block.Value("duration_rule").(string)
		known := false
		for _, item := range DurationRules {
			known = known || item == rule
		}
		if !known {
			return nil, valueError("duration_rule должен быть одним из: %s.", strings.Join(DurationRules, ", "))
		}
	}
	for _, field := range []string{"resolution", "aspect_ratio", "model"} {
		if value, ok := block.Get(field); ok {
			if text, isString := value.(string); !isString || toolrt.Strip(text) == "" {
				return nil, valueError("generation.%s.%s должен быть непустой строкой.", kind, field)
			}
		}
	}
	// auto допускается в настройках обоих медиа; возможности модели проверяются при подготовке запроса.
	if value, ok := block.Get("aspect_ratio"); ok && !aspectRatio.MatchString(value.(string)) && value != "auto" {
		return nil, valueError("aspect_ratio записывается как 16:9 или auto.")
	}
	if value, ok := block.Get("watermark"); ok {
		if _, isBool := value.(bool); !isBool {
			return nil, valueError("generation.%s.watermark должен быть логическим значением.", kind)
		}
	}
	if value, ok := block.Get("provider_selected"); ok {
		if _, isBool := value.(bool); !isBool {
			return nil, valueError("generation.%s.provider_selected должен быть логическим значением.", kind)
		}
	}
	if value, ok := block.Get("options"); ok {
		if _, isDict := value.(*toolrt.Dict); !isDict {
			return nil, valueError("generation.%s.options должен быть объектом.", kind)
		}
	}
	if value, ok := block.Get("outputs"); ok && kind == "image" {
		if number, isInt := value.(toolrt.Int); !isInt || number.Sign() < 1 {
			return nil, valueError("generation.image.outputs должен быть положительным целым числом.")
		}
	}
	return toolrt.DeepCopy(block).(*toolrt.Dict), nil
}

// LoadProject — plan/project.json, проверенный ValidateProject. Ошибки чтения
// и разбора — OSError, UnicodeDecodeError или JSONDecodeError toolrt.
func LoadProject(root string, validateGeneration bool) (*toolrt.Dict, error) {
	value, err := toolrt.LoadJSONFile(filepath.Join(root, filepath.FromSlash(ProjectPath)))
	if err != nil {
		return nil, err
	}
	return ValidateProject(value, validateGeneration)
}
