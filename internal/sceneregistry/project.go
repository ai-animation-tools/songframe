// Package sceneregistry — перенос tools/scene_registry/scene_registry.py замороженного оригинала:
// единственный источник постановки и монтажного времени для Python-инструментов. Пакет проверяет
// plan/project.json и plan/scenes.json, разворачивает сюжетные состояния планов, считает отпечатки
// постановки, свежесть принятых комплектов и монтажное время планов.
//
// Пакет — общая основа для перенесённых инструментов (scene_scaffold, lint_registry, check_assets,
// check_workspace, shot_status): все они в оригинале импортировали этот модуль. Поэтому значения —
// модель pycompat, а ошибки — исключения Python (*pycompat.Exception) с текстами оригинала:
// инструмент печатает str(error) и выбирает код завершения по типу исключения.
//
// Отличия устройства от Python, не меняющие результат:
//   - начальное состояние сущностей передаётся явно (initial). В Python initial=None означал
//     initial_states_for(ROOT) — кастинг проекта, на котором запущен инструмент; в Go это
//     InitialStatesFor(root) у вызывающего. Кэша по проекту нет: каждый вызов читает кастинг заново,
//     поэтому долгоживущий процесс приложения не видит устаревших данных (Python кэшировал на
//     время одного запуска инструмента);
//   - хеши роликов кэширует internal/filedigest (та же идентичность файла, что stat-кэш оригинала).
//
// Страницы приложения используют перенос TS-оригинала (internal/scenario, internal/acceptance):
// он принимает и проверяет данные по правилам главного процесса Electron, которые в краевых
// случаях отличаются от Python (см. testdata/golden/README.md, домен scene-registry).
package sceneregistry

import (
	"path/filepath"
	"regexp"
	"strings"

	"songframe-go/internal/pycompat"
)

// Пути внутри проекта.
const (
	ProjectPath      = "plan/project.json"
	ScenesPath       = "plan/scenes.json"
	ProductionStatus = "plan/production-status.json"
)

// Регулярные выражения оригинала. \d и \w Python для str — классы Unicode.
var (
	// ShotID — SHOT_ID: код плана Mxx или Mxx.n.
	ShotID = regexp.MustCompile(`^M\p{Nd}{2}(?:\.\p{Nd}+)?$`)
	// SHA256 — hex-отпечаток в нижнем регистре.
	SHA256       = regexp.MustCompile(`^[0-9a-f]{64}$`)
	slug         = regexp.MustCompile(`^[a-z][a-z0-9_]*$`)
	mp4Name      = regexp.MustCompile(`^[\p{L}\p{N}_.-]+\.mp4$`)
	aspectRatio  = regexp.MustCompile(`^\p{Nd}+:\p{Nd}+$`)
	newlineChars = "\r\n"
)

// fullmatch — re.fullmatch(pattern, value): не-строка — TypeError, как у модуля re.
func fullmatch(pattern *regexp.Regexp, value any) (bool, error) {
	text, ok := value.(string)
	if !ok {
		return false, pycompat.Raise(pycompat.TypeError, "expected string or bytes-like object, got '%s'", pycompat.TypeName(value))
	}
	return pattern.MatchString(text), nil
}

// valueError — ValueError с форматированным текстом.
func valueError(format string, args ...any) error {
	return pycompat.Raise(pycompat.ValueError, format, args...)
}

// GenerationFields — GENERATION_FIELDS: обязательные поля generation.video и их типы.
var GenerationFields = []string{"provider", "resolution", "aspect_ratio", "watermark", "duration_rule"}

// DurationRules — DURATION_RULES: допустимые правила длительности видео.
var DurationRules = []string{"min_supported_strictly_greater_than_window", "min_supported_not_less_than_window", "exact_window"}

// ValidateProject — validate_project: схема, название без переводов строк, имя MP4 аниматика,
// строковые agent_instructions и, если validateGeneration, независимые блоки generation.video и
// generation.image (GenerationSettings). Возвращает тот же документ.
func ValidateProject(data any, validateGeneration bool) (*pycompat.Dict, error) {
	document, ok := data.(*pycompat.Dict)
	name, isString := document.Value("name").(string)
	if !ok || !pycompat.Equal(document.Value("schema_version"), pycompat.NewInt(1)) || !isString ||
		pycompat.Strip(name) == "" || strings.ContainsAny(name, newlineChars) {
		return nil, valueError("В plan/project.json нужны схема и непустое название проекта.")
	}
	filename, isString := document.Value("animatic_video").(string)
	if !isString || !mp4Name.MatchString(filename) || strings.HasPrefix(filename, ".") {
		return nil, valueError("animatic_video должен быть именем MP4 без пути к папке.")
	}
	if value, ok := document.Get("agent_instructions"); ok {
		if _, isString := value.(string); !isString {
			return nil, valueError("plan/project.json: agent_instructions должен быть строкой.")
		}
	}
	generation := document.Value("generation")
	if validateGeneration && generation != nil {
		block, ok := generation.(*pycompat.Dict)
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

// GenerationSettings — generation_settings(data, kind): копия проверенного блока generation.video
// или generation.image без изменения данных проекта.
func GenerationSettings(data any, kind string) (*pycompat.Dict, error) {
	if kind != "video" && kind != "image" {
		return nil, valueError("Вид генерации должен быть video или image.")
	}
	var generation *pycompat.Dict
	if document, ok := data.(*pycompat.Dict); ok {
		generation, _ = document.Value("generation").(*pycompat.Dict)
	}
	if generation == nil {
		return nil, valueError("В plan/project.json нет блока generation.%s.", kind)
	}
	block, ok := generation.Value(kind).(*pycompat.Dict)
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
		if text, isString := value.(string); !isString || pycompat.Strip(text) == "" {
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
			if text, isString := value.(string); !isString || pycompat.Strip(text) == "" {
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
		if _, isDict := value.(*pycompat.Dict); !isDict {
			return nil, valueError("generation.%s.options должен быть объектом.", kind)
		}
	}
	if value, ok := block.Get("outputs"); ok && kind == "image" {
		if number, isInt := value.(pycompat.Int); !isInt || number.Sign() < 1 {
			return nil, valueError("generation.image.outputs должен быть положительным целым числом.")
		}
	}
	return pycompat.DeepCopy(block).(*pycompat.Dict), nil
}

// LoadProject — load_project(root): plan/project.json, проверенный ValidateProject. Ошибки чтения
// и разбора — OSError, UnicodeDecodeError или JSONDecodeError Python.
func LoadProject(root string, validateGeneration bool) (*pycompat.Dict, error) {
	value, err := pycompat.LoadJSONFile(filepath.Join(root, filepath.FromSlash(ProjectPath)))
	if err != nil {
		return nil, err
	}
	return ValidateProject(value, validateGeneration)
}
