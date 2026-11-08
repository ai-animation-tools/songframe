// Package projectfile владеет правкой маркера проекта plan/project.json: переименование и
// редактируемая часть настроек — название, имя MP4 аниматика, постоянные инструкции агенту и блок
// generation. Чтение маркера для статуса остаётся у internal/status.
//
// Документ обрабатывается деревом dynvalue: неизвестные поля, порядок ключей документа и
// форма чисел сохраняются байт в байт (эталоны testdata/golden/project-rename и
// project-settings). Запись атомарна и проходит шлюз записи projectfs: проект с незавершённой
// многофайловой публикацией не правится.
package projectfile

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"

	"songframe/internal/dynvalue"
	"songframe/internal/projectfs"
)

// Тексты frontend/src/shared/texts (projectsTexts.main, checksTexts,
// projectTexts.agentInstructions) и ошибок чтения локальных JSON-файлов.
const (
	emptyName            = "Название проекта не может быть пустым."
	invalidNameCharacter = "Название проекта содержит недопустимый символ."
	invalidMarker        = "В папке нет корректного plan/project.json с названием проекта."
	instructionsInvalid  = "plan/project.json: agent_instructions должен быть строкой."
	animaticInvalid      = "Имя MP4 аниматика: буквы, цифры, точки и дефисы, без пути к папке, с расширением .mp4."
	objectExpected       = "ожидался JSON-объект"
)

// relativeFile — путь маркера в сообщениях настроек с системным разделителем.
var relativeFile = filepath.Join("plan", "project.json")

// File — путь маркера внутри проекта.
func File(project string) string { return filepath.Join(project, "plan", "project.json") }

// encode — JSON с отступом в два пробела и переводом строки в конце.
func encode(value any) []byte { return []byte(dynvalue.StringifyIndent(value, "  ") + "\n") }

// write атомарно заменяет маркер после проверки шлюза; права существующего файла сохраняются.
func write(project string, value any) error {
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	return projectfs.WriteFile(File(project), encode(value), 0)
}

// readLocal читает маркер: отсутствие файла даёт (nil, nil), повреждённый или
// не-объектный JSON — ошибку с путём; файл при этом не трогается.
func readLocal(path string) (any, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, readFailed(path, dynvalue.FsError("open", path, err).Error())
	}
	value, err := dynvalue.Parse([]byte(dynvalue.DecodeUTF8(data)))
	if err != nil {
		return nil, readFailed(path, err.Error())
	}
	if _, isObject := dynvalue.AsObject(value); !isObject && !dynvalue.IsArray(value) {
		return nil, readFailed(path, objectExpected)
	}
	return value, nil
}

func readFailed(path, reason string) error {
	return fmt.Errorf("Не удалось прочитать %s: %s. Файл сохранён; исправьте его или перенесите в резервную папку.", path, reason)
}

// hasMarker — readProjectMarker на уже прочитанном документе: непустое строковое name.
func hasMarker(data any) bool {
	name, ok := dynvalue.Get(data, "name").(string)
	return ok && name != ""
}

// nameCharacters — символы, которые сломали бы однострочное название в истории и заголовках.
var nameCharacters = regexp.MustCompile("[\x00\r\n]")

// Rename меняет только name в plan/project.json (без переноса папки и MP4) и возвращает
// записанное название без пробелов по краям. Историю и статус обновляет вызывающий сервис;
// beforeWrite (проверка истории) вызывается после проверки названия и маркера, до записи.
func Rename(project, name string, beforeWrite func() error) (string, error) {
	if dynvalue.Trim(name) == "" {
		return "", errors.New(emptyName)
	}
	if nameCharacters.MatchString(name) {
		return "", errors.New(invalidNameCharacter)
	}
	data, err := readLocal(File(project))
	if err != nil {
		return "", err
	}
	object, ok := dynvalue.AsObject(data)
	if !ok || !hasMarker(object) {
		return "", errors.New(invalidMarker)
	}
	if beforeWrite != nil {
		if err := beforeWrite(); err != nil {
			return "", err
		}
	}
	next := dynvalue.Trim(name)
	// Копия документа с новым name: ключ остаётся на своей позиции, остальные поля не меняются.
	updated := object.Clone()
	updated.Set("name", next)
	if err := write(project, updated); err != nil {
		return "", err
	}
	return next, nil
}

// Settings — ProjectSettings контракта. Generation — блок plan/project.json как есть (JSON
// с неизвестными полями провайдеров) или null, если блока нет или он не объект.
type Settings struct {
	AgentInstructions string          `json:"agentInstructions"`
	Name              string          `json:"name"`
	AnimaticVideo     string          `json:"animaticVideo"`
	Generation        json.RawMessage `json:"generation"`
}

// SettingsInput — ProjectSettings из формы. AgentInstructions nil не меняет поле в файле.
//
// Unset — пути внутри generation, значения которых форма задала как undefined (сброс модели,
// разрешения и т. п.): запись удаляет такие ключи из файла. JSON-мост Wails ключи с undefined
// теряет, поэтому адаптер передаёт их отдельным списком.
type SettingsInput struct {
	AgentInstructions *string         `json:"agentInstructions,omitempty"`
	Name              string          `json:"name"`
	AnimaticVideo     string          `json:"animaticVideo"`
	Generation        json.RawMessage `json:"generation"`
	Unset             [][]string      `json:"unset"`
}

// readProjectFile читает маркер для настроек: ошибка чтения или разбора — projectReadFailed
// с относительным путём, не-объект — projectObjectRequired.
func readProjectFile(project string) (*dynvalue.Object, error) {
	path := File(project)
	bytes, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("Не удалось прочитать %s: %s", relativeFile, dynvalue.FsError("open", path, err).Error())
	}
	data, err := dynvalue.Parse([]byte(dynvalue.DecodeUTF8(bytes)))
	if err != nil {
		return nil, fmt.Errorf("Не удалось прочитать %s: %s", relativeFile, err.Error())
	}
	object, ok := dynvalue.AsObject(data)
	if !ok {
		return nil, fmt.Errorf("%s должен быть объектом.", relativeFile)
	}
	return object, nil
}

// instructions — поле agentInstructions: отсутствие поля означает пустые инструкции, другой
// тип — ошибка.
func instructions(data *dynvalue.Object) (string, error) {
	value := data.Value("agent_instructions")
	if value == dynvalue.Undefined {
		return "", nil
	}
	text, ok := value.(string)
	if !ok {
		return "", errors.New(instructionsInvalid)
	}
	return text, nil
}

// readGeneration — копия блока generation, где video/image не-объекты заменены null: поля другого
// формата не подтверждают выбор провайдера. nil означает, что блока нет или он не объект.
func readGeneration(data *dynvalue.Object) *dynvalue.Object {
	block, ok := dynvalue.AsObject(data.Value("generation"))
	if !ok {
		return nil
	}
	result := block.Clone()
	for _, kind := range []string{"video", "image"} {
		if inner, ok := dynvalue.AsObject(block.Value(kind)); ok {
			result.Set(kind, inner.Clone())
		} else {
			result.Set(kind, nil)
		}
	}
	return result
}

// ReadSettings — projects.settings: только чтение plan/project.json.
func ReadSettings(project string) (Settings, error) {
	data, err := readProjectFile(project)
	if err != nil {
		return Settings{}, err
	}
	text, err := instructions(data)
	if err != nil {
		return Settings{}, err
	}
	settings := Settings{AgentInstructions: text, Generation: json.RawMessage("null")}
	settings.Name, _ = data.Value("name").(string)
	settings.AnimaticVideo, _ = data.Value("animatic_video").(string)
	if generation := readGeneration(data); generation != nil {
		settings.Generation = dynvalue.Raw(generation)
	}
	return settings, nil
}

// durationRules — DURATION_RULES контракта в порядке сообщения.
var durationRules = []string{"min_supported_strictly_greater_than_window", "min_supported_not_less_than_window", "exact_window"}

// Шаблоны проверки: имя MP4 аниматика из ASCII-букв, цифр, «_», «.» и «-» и соотношение сторон
// «N:M» из ASCII-цифр.
var (
	animaticPattern = regexp.MustCompile(`^[A-Za-z0-9_.-]+\.mp4$`)
	aspectPattern   = regexp.MustCompile(`^\d+:\d+$`)
)

// Validate проверяет настройки: структурные правила блока generation совпадают с
// scene_registry; готовность провайдера проверяется отдельно. generation — разобранный ввод формы.
func Validate(name, animaticVideo string, generation any) []string {
	problems := []string{}
	if dynvalue.Trim(name) == "" {
		problems = append(problems, emptyName)
	}
	if !animaticPattern.MatchString(animaticVideo) || strings.HasPrefix(animaticVideo, ".") {
		problems = append(problems, animaticInvalid)
	}
	if !dynvalue.Truthy(generation) {
		return problems
	}
	for _, kind := range []string{"video", "image"} {
		block := dynvalue.Get(generation, kind)
		if dynvalue.IsNullish(block) {
			continue
		}
		record, ok := dynvalue.AsObject(block)
		if !ok {
			problems = append(problems, "generation."+kind+": ожидается объект настроек.")
			continue
		}
		required := []string{"provider"}
		if kind == "video" {
			required = []string{"provider", "resolution", "aspect_ratio", "duration_rule"}
		}
		isRequired := map[string]bool{}
		for _, field := range required {
			isRequired[field] = true
			if text, ok := record.Value(field).(string); !ok || dynvalue.Trim(text) == "" {
				problems = append(problems, "generation."+kind+": не заполнено поле "+field+".")
			}
		}
		for _, field := range []string{"resolution", "aspect_ratio", "model"} {
			value := record.Value(field)
			text, isString := value.(string)
			if value != dynvalue.Undefined && (!isString || dynvalue.Trim(text) == "") && !isRequired[field] {
				problems = append(problems, "generation."+kind+": "+field+" должен быть непустой строкой.")
			}
		}
		if aspect := record.Value("aspect_ratio"); aspect != dynvalue.Undefined {
			text, isString := aspect.(string)
			if !isString || (!aspectPattern.MatchString(text) && text != "auto") {
				problems = append(problems, "generation."+kind+": пропорции записываются как 16:9 или auto.")
			}
		}
		if watermark := record.Value("watermark"); kind == "video" || watermark != dynvalue.Undefined {
			if _, isBool := watermark.(bool); !isBool {
				problems = append(problems, "generation."+kind+": watermark должен быть логическим значением.")
			}
		}
		if rule, isString := record.Value("duration_rule").(string); kind == "video" && !(isString && slices.Contains(durationRules, rule)) {
			problems = append(problems, "generation."+kind+": правило длительности должно быть одним из: "+strings.Join(durationRules, ", ")+".")
		}
		if selected := record.Value("provider_selected"); selected != dynvalue.Undefined {
			if _, isBool := selected.(bool); !isBool {
				problems = append(problems, "generation."+kind+": provider_selected должен быть логическим значением.")
			}
		}
		if options := record.Value("options"); options != dynvalue.Undefined && !dynvalue.IsRecord(options) {
			problems = append(problems, "generation."+kind+": options должен быть объектом.")
		}
		if outputs := record.Value("outputs"); kind == "image" && outputs != dynvalue.Undefined && (!dynvalue.IsInteger(outputs) || dynvalue.ToNumber(outputs) < 1) {
			problems = append(problems, "generation."+kind+": outputs должен быть положительным целым числом.")
		}
	}
	return problems
}

// merge — известные поля формы поверх сохранённых, вложенные объекты (options,
// backend провайдера) сливаются рекурсивно, новые ключи встают в конец.
func merge(previous, current *dynvalue.Object) *dynvalue.Object {
	result := previous.Clone()
	for _, key := range current.Keys() {
		value := current.Value(key)
		incoming, incomingRecord := dynvalue.AsObject(value)
		existing, existingRecord := dynvalue.AsObject(result.Value(key))
		if incomingRecord && existingRecord {
			result.Set(key, merge(existing, incoming))
		} else {
			result.Set(key, value)
		}
	}
	return result
}

// unset удаляет из слитого блока ключи, которые форма передала как undefined.
func unset(generation any, paths [][]string) {
	for _, path := range paths {
		if len(path) == 0 {
			continue
		}
		node := generation
		for _, key := range path[:len(path)-1] {
			node = dynvalue.Get(node, key)
		}
		if object, ok := dynvalue.AsObject(node); ok {
			object.Delete(path[len(path)-1])
		}
	}
}

// parseGeneration разбирает generation формы; отсутствие и null равнозначны (блока нет).
func parseGeneration(raw json.RawMessage) (any, error) {
	if len(raw) == 0 {
		return nil, nil
	}
	return dynvalue.Parse(raw)
}

// WriteSettings — projects.saveSettings: проверка формы, слияние с сохранённым блоком generation
// и атомарная запись plan/project.json. Возвращает настройки, прочитанные заново из файла.
//
// Повреждённый непоказанный блок (video/image или весь generation не объект) не исчезает от
// сохранения имени или MP4: его заменяет только явное заполнение формы.
func WriteSettings(project string, input SettingsInput) (Settings, error) {
	generationInput, err := parseGeneration(input.Generation)
	if err != nil {
		return Settings{}, fmt.Errorf("неверный блок generation: %w", err)
	}
	// Для проверки undefined и отсутствие равнозначны; удаление учитывается при слиянии.
	if problems := Validate(input.Name, input.AnimaticVideo, generationInput); len(problems) > 0 {
		return Settings{}, errors.New(strings.Join(problems, " "))
	}
	data, err := readProjectFile(project)
	if err != nil {
		return Settings{}, err
	}
	// Если поле не меняют, сохранённое значение проверяется до записи остальных настроек.
	if input.AgentInstructions == nil {
		if _, err := instructions(data); err != nil {
			return Settings{}, err
		}
	}
	var generation any
	if dynvalue.Truthy(generationInput) {
		previous := readGeneration(data)
		if previous == nil {
			previous = dynvalue.NewObject()
		}
		if incoming, ok := dynvalue.AsObject(generationInput); ok {
			merged := merge(previous, incoming)
			unset(merged, input.Unset)
			generation = merged
		} else {
			// Форма присылает объект или null; другое значение пишется как есть, без слияния.
			generation = generationInput
		}
	}
	stored := data.Value("generation")
	if merged, ok := dynvalue.AsObject(generation); ok && dynvalue.IsRecord(stored) {
		for _, kind := range []string{"video", "image"} {
			old := dynvalue.Get(stored, kind)
			if dynvalue.Get(generationInput, kind) == nil && !dynvalue.IsNullish(old) && !dynvalue.IsRecord(old) {
				merged.Set(kind, old)
			}
		}
	} else if !dynvalue.Truthy(generation) && !dynvalue.IsNullish(stored) && !dynvalue.IsRecord(stored) {
		generation = stored
	}
	next := data.Clone()
	next.Set("name", dynvalue.Trim(input.Name))
	next.Set("animatic_video", input.AnimaticVideo)
	if input.AgentInstructions != nil {
		// Текст инструкций принадлежит пользователю: пробелы и переносы строк сохраняются дословно.
		next.Set("agent_instructions", *input.AgentInstructions)
	}
	next.Set("generation", generation)
	if _, isNumber := next.Value("schema_version").(float64); !isNumber {
		next.Set("schema_version", 1.0)
	}
	if err := write(project, next); err != nil {
		return Settings{}, err
	}
	return ReadSettings(project)
}
