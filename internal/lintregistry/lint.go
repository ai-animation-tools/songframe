// Package lintregistry проверяет plan/scenes.json, кастинг, описание, комплекты assets, файл
// принятия и рабочие пакеты по встроенным JSON-схемам (подмножество JSON Schema) и правилам
// владения сведениями (хроника принятий и технические рецепты не хранятся в постановке).
//
// Вывод зафиксирован эталоном testdata/golden/lint-registry: строки «ОШИБКА/предупреждение  файл · место: текст»
// и итог, либо JSON {errors, warnings} с --json; код 1 при ошибках (и предупреждениях с --strict).
// Данные неожиданной формы дают исключение toolrt (необработанная ошибка, код 1), зафиксированное тем же
// эталоном. Пакет только читает файлы проекта; схемы встроены в бинарник, регулярные выражения —
// internal/toolregex.
package lintregistry

import (
	"embed"
	"path/filepath"
	"sort"
	"strings"

	"songframe/internal/castregistry"
	"songframe/internal/mediaadapters"
	"songframe/internal/sceneregistry"
	"songframe/internal/toolcli"
	"songframe/internal/toolregex"
	"songframe/internal/toolrt"
)

//go:embed schemas/*.schema.json
var schemaFiles embed.FS

// Parser — разбор аргументов lint_registry; Prog и описание видны в справке и ошибках разбора.
var Parser = toolrt.ArgParser{
	Prog:        "lint_registry",
	Description: "Проверка реестра, комплектов и пакетов по схемам и правилам владения сведениями; @link README.md",
	Flags: []toolrt.Flag{
		{Name: "--json"},
		{Name: "--strict", Help: "Предупреждения тоже считать ошибками"},
	},
}

// productionWords — основы слов производства, признак хроники в тексте постановки.
const productionWords = `(проб|участ|клип|генерац|склейк|переход|видео|кадр|монтаж|обрезк|включ|версия|v\d)`

// historyPattern — шаблон признака хроники и подпись найденного в отчёте.
type historyPattern struct {
	pattern *toolregex.Regexp
	label   string
}

// historyPatterns — признаки хроники принятий и технических рецептов в постановке (без учёта
// регистра); проверяются по порядку, на каждый шаблон — первое совпадение.
var historyPatterns = []historyPattern{
	{toolregex.MustCompile(`(?:`+productionWords+`[^.;]{0,60}\bприняты?\b)|(?:\bприняты?\b[^.;]{0,60}`+productionWords+`)|\bпринята (новая|генерация|обрезка)`, toolregex.IgnoreCase), "факт принятия"},
	{toolregex.MustCompile(`\bвключен[аоы]? в v\d+`, toolregex.IgnoreCase), "ссылка на версию аниматика"},
	{toolregex.MustCompile(`(?<![\w_-])v\d{2}\b`, toolregex.IgnoreCase), "номер версии"},
	{toolregex.MustCompile(`\bв пробе\b|\bпроба [A-ZМ]\d`, toolregex.IgnoreCase), "упоминание пробы"},
	{toolregex.MustCompile(`assets/shots/`, toolregex.IgnoreCase), "путь в assets"},
	{toolregex.MustCompile(`manifest\.json`, toolregex.IgnoreCase), "ссылка на технический файл"},
	{toolregex.MustCompile(`\bархив`, toolregex.IgnoreCase), "упоминание архива"},
	{toolregex.MustCompile(`\bпрежн(яя|ий|ие|его|ей) верси`, toolregex.IgnoreCase), "прежняя версия"},
	{toolregex.MustCompile(`\bоригинал[а-я]* \d|\bучаст(ок|ка) \d|\d[,.]\d+\s*×|\bна 1×|\bускорен[а-я]* на|\bзамедлен[а-я]* до|\d+/\d+\s*≈|\b\d+ кадр(а|ов)? (на|при) \d`, toolregex.IgnoreCase), "технический рецепт монтажа"},
	{toolregex.MustCompile(`\b(оригинал|клип|видео|версия|кандидат)[^.;]{0,40}\bсохран(ён|ены|ена|ено)\b`, toolregex.IgnoreCase), "факт сохранения"},
}

var (
	// markdownLink — цель ссылки Markdown «](цель)» в группе 1.
	markdownLink = toolregex.MustCompile(`\]\(([^)]+)\)`, 0)
	// imageLink — путь изображения по расширению png, jpg, jpeg или webp без учёта регистра.
	imageLink = toolregex.MustCompile(`\.(png|jpe?g|webp)$`, toolregex.IgnoreCase)
	// derivedLinks — имена производных представлений, на которые постановка не ссылается.
	derivedLinks = toolregex.MustCompile(`edit-list\.md|production-status\.json|storyboard\.md|ROADMAP\.md`, 0)
)

// snapshotForbidden — служебные поля, которые не хранятся в снимке assets.
var snapshotForbidden = map[string]bool{
	"prepared_at": true, "account_checked_at": true, "cost": true, "available_credits": true, "video_submitted": true,
	"result_saved": true, "status": true, "notes": true, "revision": true, "revision_reason": true, "stage": true,
	"attempt": true, "cli_version": true, "approved_at": true, "approval": true, "created_at": true, "updated_at": true,
	"saved_at": true, "submitted_at": true, "submission_started_at": true, "downloaded_at": true, "last_query_at": true,
	"capabilities_checked_at": true, "balance": true, "pricing": true, "credits_consumed": true, "creditsConsumed": true,
	"download_status": true, "service_statuses": true, "submitted": true, "uploaded": true,
}

// snapshotAliases — каноническое имя поля снимка и его устаревшие формы; порядок групп задаёт
// порядок предупреждений.
var snapshotAliases = [][]string{
	{"generation_id", "generationId"},
	{"parameters", "arguments"},
	{"prompt", "prompt_file", "prompt_path"},
	{"provider", "service"},
}

// awaitingStages — допустимые этапы пакета в plan/awaiting.
var awaitingStages = []any{"ready", "needs_revision", "edit_review", "submitted", "downloaded", "image_request_choice", "image_submitted", "image_downloaded"}

// Тексты проверок; дословно сверяются эталоном testdata/golden/lint-registry.
const (
	textFileMissing      = "файл отсутствует"
	textAwaitingStage    = "пакет в очереди должен быть на этапе ready, needs_revision, edit_review, submitted, downloaded или image_request_choice/image_submitted/image_downloaded"
	textSnapshotService  = "служебное поле времени, состояния или баланса не хранится в assets"
	textSnapshotModel    = "снимок должен называть модель и промпт"
	textSnapshotProvider = "снимок должен называть провайдера генерации"
	textSnapshotID       = "поле обязательно; при неизвестном ID — null и причина в provenance"
	textSnapshotReason   = "ID задания отсутствует, но причина не записана"
	textStatusObject     = "файл должен быть объектом"
	textNoWorld          = "нет сущности world: время суток, погода и стороны дороги негде хранить"
	textReferencesDrift  = "карта references расходится с кастингом: сохраните кастинг, и карта обновится."
	textCardReference    = "главный референс карточки не объявлен"
	textAcceptedNoScene  = "отпечаток принятия плана, которого нет в реестре"
	textAcceptedNoKit    = "отпечаток принятия плана без комплекта в assets"
)

// item — запись отчёта {level, file, where, message}.
type item struct{ level, file, where, message string }

// Report — отчёт проверки: ошибки и предупреждения в порядке обнаружения.
type Report struct {
	Errors, Warnings []item
}

func (r *Report) error(file, where, message string) {
	r.Errors = append(r.Errors, item{"error", file, where, message})
}

func (r *Report) warning(file, where, message string) {
	r.Warnings = append(r.Warnings, item{"warning", file, where, message})
}

// schemaError — запись сообщения validate: место — до первого «:», текст — после первого «: ».
func (r *Report) schemaError(file, message string) {
	where, _, _ := strings.Cut(message, ":")
	_, text, _ := strings.Cut(message, ": ")
	r.error(file, where, text)
}

// readJSON — JSON файла проекта name: отсутствующий файл — nil; ValueError (JSON, UTF-8)
// — ошибка отчёта и nil; прочие ошибки чтения (каталог, права) — исключение.
func readJSON(root, name string, r *Report) (any, error) {
	value, err := toolrt.LoadJSONFile(toolrt.JoinPath(root, name))
	switch {
	case err == nil:
		return value, nil
	case toolrt.Is(err, toolrt.FileNotFoundError):
		return nil, nil
	case toolrt.Is(err, toolrt.ValueError):
		r.error(name, "$", "JSON не разбирается: "+err.Error())
		return nil, nil
	}
	return nil, err
}

// expectString — текст для поиска регулярным выражением; нестроковое значение — исключение
// toolrt TypeError.
func expectString(value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", toolrt.Raise(toolrt.TypeError, "ожидается строка, получено: %s", toolrt.TypeName(value))
	}
	return text, nil
}

// historyHits — найденные признаки хроники с контекстом ±30 символов.
func historyHits(value any) ([]string, error) {
	text, err := expectString(value)
	if err != nil {
		return nil, err
	}
	runes := toolrt.Runes(text)
	hits := []string{}
	for _, entry := range historyPatterns {
		match, ok := entry.pattern.Search(text)
		if !ok {
			continue
		}
		start := max(0, match.Start()-30)
		end := min(len(runes), match.End()+30)
		hits = append(hits, entry.label+": «…"+toolrt.Strip(toolrt.FromRunes(runes[start:end]))+"…»")
	}
	return hits, nil
}

// links — цели всех ссылок Markdown текста по порядку.
func links(value any) ([]string, error) {
	text, err := expectString(value)
	if err != nil {
		return nil, err
	}
	result := []string{}
	for _, match := range markdownLink.FindAll(text) {
		target, _ := match.Group(1)
		result = append(result, target)
	}
	return result, nil
}

// get — значение ключа словаря или fallback (toolrt.DictGet); не-словарь — AttributeError.
func get(value any, key string, fallback any) (any, error) {
	return toolrt.DictGet(value, key, fallback)
}

// lintScenes — plan/scenes.json: схема, ссылки и хроника в постановке, референсы и derived_from.
func lintScenes(root string, r *Report) (any, error) {
	data, err := readJSON(root, sceneregistry.ScenesPath, r)
	if err != nil {
		return nil, err
	}
	if data == nil {
		r.error(sceneregistry.ScenesPath, "$", textFileMissing)
		return nil, nil
	}
	for _, message := range validateSchema(data, "scenes") {
		r.schemaError(sceneregistry.ScenesPath, message)
	}
	document, ok := data.(*toolrt.Dict)
	if !ok {
		return data, nil
	}
	direction, _ := get(document, "visual_direction", "")
	targets, err := links(direction)
	if err != nil {
		return nil, err
	}
	// Ссылки на изображения внутри assets означают, что действующий референс живёт не в source.
	for _, target := range targets {
		if _, image := imageLink.Search(target); strings.Contains(target, "assets/") && image {
			r.error(sceneregistry.ScenesPath, "visual_direction", "референс-изображение в assets вместо source: "+target)
		} else if strings.Contains(target, "assets/") {
			r.warning(sceneregistry.ScenesPath, "visual_direction", "ссылка на принятый материал как ориентир непрерывности: "+target)
		}
	}
	hits, err := historyHits(direction)
	if err != nil {
		return nil, err
	}
	for _, hit := range hits {
		r.warning(sceneregistry.ScenesPath, "visual_direction", hit)
	}
	sequencesValue, _ := get(document, "sequences", []any{})
	sequences, err := toolrt.Iter(sequencesValue)
	if err != nil {
		return nil, err
	}
	for _, sequence := range sequences {
		id, err := get(sequence, "id", nil)
		if err != nil {
			return nil, err
		}
		where := "sequences[" + toolrt.Str(id) + "].direction"
		text, _ := get(sequence, "direction", "")
		hits, err := historyHits(text)
		if err != nil {
			return nil, err
		}
		for _, hit := range hits {
			r.error(sceneregistry.ScenesPath, where, hit)
		}
		targets, err := links(text)
		if err != nil {
			return nil, err
		}
		for _, target := range targets {
			if strings.Contains(target, "assets/") {
				r.error(sceneregistry.ScenesPath, where, "ссылка в assets: "+target)
			} else if _, derived := derivedLinks.Search(target); derived {
				r.warning(sceneregistry.ScenesPath, where, "ссылка на производное представление вместо первичного источника: "+target)
			}
		}
	}
	referencesValue, _ := get(document, "references", toolrt.NewDict())
	referenceKeys, err := toolrt.SetOf(referencesValue)
	if err != nil {
		return nil, err
	}
	scenesValue, _ := get(document, "scenes", []any{})
	scenes, err := toolrt.Iter(scenesValue)
	if err != nil {
		return nil, err
	}
	for _, scene := range scenes {
		sidValue, err := get(scene, "id", "?")
		if err != nil {
			return nil, err
		}
		sid := toolrt.Str(sidValue)
		for _, field := range []string{"action", "continuity", "notes"} {
			text, _ := get(scene, field, "")
			if !toolrt.Truthy(text) {
				text = ""
			}
			hits, err := historyHits(text)
			if err != nil {
				return nil, err
			}
			for _, hit := range hits {
				r.error(sceneregistry.ScenesPath, sid+"."+field, hit)
			}
		}
		keysValue, _ := get(scene, "references", []any{})
		keys, err := toolrt.Iter(keysValue)
		if err != nil {
			return nil, err
		}
		for _, key := range keys {
			if toolrt.Equal(key, "—") {
				continue
			}
			found, err := referenceKeys.Has(key)
			if err != nil {
				return nil, err
			}
			if !found {
				r.error(sceneregistry.ScenesPath, sid+".references", "неизвестный референс "+toolrt.Str(key))
			}
		}
		card, _ := get(scene, "card", toolrt.NewDict())
		primary, err := get(card, "primary_reference", nil)
		if err != nil {
			return nil, err
		}
		found, err := referenceKeys.Has(primary)
		if err != nil {
			return nil, err
		}
		if !found {
			r.error(sceneregistry.ScenesPath, sid+".card", textCardReference)
		}
	}
	// Форму derived_from проверяет схема; здесь только ссылки на другие планы.
	var list any = []any{}
	if items, ok := document.Value("scenes").([]any); ok {
		list = items
	}
	problems, err := sceneregistry.DerivedFromProblems(list)
	if err != nil {
		return nil, err
	}
	for _, problem := range problems {
		if problem.Message != sceneregistry.DerivedFormat {
			message := strings.TrimRight(strings.TrimPrefix(problem.Message, "derived_from "), ".")
			r.error(sceneregistry.ScenesPath, toolrt.Str(problem.Shot)+".derived_from", message)
		}
	}
	return data, nil
}

// castReferences — референсы кастинга по id сущности (имя, путь первого изображения в source/,
// краткое имя) для сверки с реестром. KeyError и TypeError перехватываются
// (ok=false — сверка пропускается), AttributeError (сущность не словарь) — нет.
// nonString — у сущности с изображением нестроковый id: такой ключ не совпадёт с JSON-картой.
func castReferences(cast *toolrt.Dict) (result *toolrt.Dict, nonString, ok bool, err error) {
	result = toolrt.NewDict()
	entities, _ := cast.Value("entities").([]any)
	caught := func(err error) (*toolrt.Dict, bool, bool, error) {
		if toolrt.IsAny(err, toolrt.KeyError, toolrt.TypeError) {
			return nil, false, false, nil
		}
		return nil, false, false, err
	}
	for _, value := range entities {
		images, err := get(value, "images", nil)
		if err != nil {
			return caught(err)
		}
		if !toolrt.Truthy(images) {
			continue
		}
		entity := value.(*toolrt.Dict)
		name, err := toolrt.Item(entity, "name")
		if err != nil {
			return caught(err)
		}
		first, err := toolrt.GetItem(images, toolrt.NewInt(0))
		if err != nil {
			return caught(err)
		}
		path, err := toolrt.Add("source/", first)
		if err != nil {
			return caught(err)
		}
		reference := toolrt.NewDict()
		reference.Set("name", name)
		reference.Set("path", path)
		if short := entity.Value("short_name"); toolrt.Truthy(short) && !toolrt.Equal(short, name) {
			reference.Set("short_name", short)
		}
		id, err := toolrt.Item(entity, "id")
		if err != nil {
			return caught(err)
		}
		if _, err := toolrt.HashKey(id); err != nil {
			return caught(err)
		}
		if text, isString := id.(string); isString {
			result.Set(text, reference)
		} else {
			nonString = true
		}
	}
	return result, nonString, true, nil
}

// lintCast — необязательный plan/cast.json валиден и согласован с references реестра.
func lintCast(root string, scenes any, r *Report) error {
	if !toolrt.IsFile(toolrt.JoinPath(root, castregistry.CastPath)) {
		return nil
	}
	data, err := readJSON(root, castregistry.CastPath, r)
	if err != nil || data == nil {
		return err
	}
	for _, message := range validateSchema(data, "cast") {
		r.schemaError(castregistry.CastPath, message)
	}
	problems, err := castregistry.Validate(data)
	if err != nil {
		return err
	}
	for _, problem := range problems {
		r.error(castregistry.CastPath, "$", problem)
	}
	cast, isDict := data.(*toolrt.Dict)
	if !isDict {
		return nil
	}
	entities, isList := cast.Value("entities").([]any)
	if !isList {
		return nil
	}
	world := false
	for _, value := range entities {
		entity, ok := value.(*toolrt.Dict)
		if !ok {
			continue
		}
		imagesValue, _ := get(entity, "images", []any{})
		if !toolrt.Truthy(imagesValue) {
			imagesValue = []any{}
		}
		images, err := toolrt.Iter(imagesValue)
		if err != nil {
			return err
		}
		for _, image := range images {
			if text, isString := image.(string); isString && !toolrt.IsFile(toolrt.JoinPath(root, "source", text)) {
				r.error(castregistry.CastPath, toolrt.Str(entity.Value("id"))+".images", "нет файла source/"+text)
			}
		}
	}
	for _, value := range entities {
		if entity, ok := value.(*toolrt.Dict); ok && toolrt.Equal(entity.Value("kind"), "world") {
			world = true
			break
		}
	}
	if !world {
		r.warning(castregistry.CastPath, "entities", textNoWorld)
	}
	derived, nonString, ok, err := castReferences(cast)
	if err != nil || !ok {
		return err
	}
	if registry, isDict := scenes.(*toolrt.Dict); isDict {
		current := registry.Value("references")
		if nonString || !toolrt.Equal(current, derived) {
			r.error(sceneregistry.ScenesPath, "references", textReferencesDrift)
		}
	}
	return nil
}

// lintDescription — герои реестра упомянуты в source/description.md.
func lintDescription(root string, data any, r *Report) error {
	path := toolrt.JoinPath(root, "source", "description.md")
	document, isDict := data.(*toolrt.Dict)
	if !toolrt.IsFile(path) || !isDict {
		return nil
	}
	text, err := toolrt.ReadText(path)
	if err != nil {
		return err
	}
	referencesValue, _ := get(document, "references", toolrt.NewDict())
	references, ok := referencesValue.(*toolrt.Dict)
	if !ok {
		return toolrt.Raise(toolrt.AttributeError, "ожидается объект, получено: %s", toolrt.TypeName(referencesValue))
	}
	for _, key := range references.Keys() {
		reference := references.Value(key)
		name, err := get(reference, "name", "")
		if err != nil {
			return err
		}
		pathValue, _ := get(reference, "path", "")
		location, isString := pathValue.(string)
		if !isString {
			return toolrt.Raise(toolrt.AttributeError, "ожидается строка, получено: %s", toolrt.TypeName(pathValue))
		}
		if !strings.HasPrefix(location, "source/heroes/") || !toolrt.Truthy(name) {
			continue
		}
		title, isString := name.(string)
		if !isString {
			return toolrt.Raise(toolrt.AttributeError, "ожидается строка, получено: %s", toolrt.TypeName(name))
		}
		words := strings.FieldsFunc(title, toolrt.IsSpace)
		if len(words) == 0 {
			return toolrt.Raise(toolrt.IndexError, "индекс за пределами списка")
		}
		if !strings.Contains(text, words[0]) {
			r.warning("source/description.md", key, "персонаж «"+title+"» из реестра не упомянут в сценарии")
		}
	}
	return nil
}

// lintSnapshot — технический снимок запроса принятого комплекта.
func lintSnapshot(root, name string, r *Report) error {
	snapshot, err := readJSON(root, name, r)
	if err != nil || snapshot == nil {
		return err
	}
	keys, err := toolrt.SetOf(snapshot)
	if err != nil {
		return err
	}
	forbidden := []string{}
	for _, key := range keys.Items() {
		if text, isString := key.(string); isString && snapshotForbidden[text] {
			forbidden = append(forbidden, text)
		}
	}
	sort.Strings(forbidden)
	for _, key := range forbidden {
		r.error(name, key, textSnapshotService)
	}
	present := map[string]string{}
	for _, names := range snapshotAliases {
		for _, candidate := range names {
			found, err := toolrt.Contains(snapshot, candidate)
			if err != nil {
				return err
			}
			if found {
				present[names[0]] = candidate
				if candidate != names[0] {
					r.warning(name, candidate, "устаревшее имя поля; каноническое — "+names[0])
				}
				break
			}
		}
	}
	model, err := toolrt.Contains(snapshot, "model")
	if err != nil {
		return err
	}
	if _, prompt := present["prompt"]; !model || !prompt {
		r.error(name, "$", textSnapshotModel)
	}
	if _, provider := present["provider"]; !provider {
		r.error(name, "provider", textSnapshotProvider)
	}
	if key, ok := present["generation_id"]; !ok {
		r.error(name, "generation_id", textSnapshotID)
	} else {
		value, err := toolrt.GetItem(snapshot, key)
		if err != nil {
			return err
		}
		if value == nil {
			provenance, err := get(snapshot, "provenance", nil)
			if err != nil {
				return err
			}
			if !toolrt.Truthy(provenance) {
				r.error(name, "provenance", textSnapshotReason)
			}
		}
	}
	key := "provider"
	if found, ok := present["provider"]; ok {
		key = found
	}
	provider, err := get(snapshot, key, nil)
	if err != nil {
		return err
	}
	// Модельные предупреждения знает только адаптер провайдера; общая проверка о сервисах не знает.
	if !mediaadapters.Known(provider) {
		return nil
	}
	adapter, _ := mediaadapters.Get(provider)
	if warner, ok := adapter.(mediaadapters.SnapshotWarner); ok {
		warnings, err := warner.SnapshotWarnings(snapshot.(*toolrt.Dict))
		if err != nil {
			return err
		}
		for _, warning := range warnings {
			r.warning(name, warning.Where, warning.Message)
		}
	}
	return nil
}

// pathOperandError — исключение toolrt TypeError соединения пути с нестроковым компонентом.
func pathOperandError(value any) error {
	return toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(value))
}

// lintAssets — манифесты assets/shots/M*/manifest.json и их снимки запроса.
func lintAssets(root string, r *Report) error {
	manifests := toolrt.Glob(toolrt.JoinPath(root, "assets", "shots"), "M*/manifest.json")
	toolrt.SortPaths(manifests)
	for _, manifest := range manifests {
		name, err := toolrt.RelativeTo(manifest, root)
		if err != nil {
			return err
		}
		packageValue, err := readJSON(root, name, r)
		if err != nil {
			return err
		}
		if packageValue == nil {
			continue
		}
		for _, message := range validateSchema(packageValue, "manifest") {
			r.schemaError(name, message)
		}
		var request any
		if document, ok := packageValue.(*toolrt.Dict); ok {
			generation, _ := get(document, "generation", toolrt.NewDict())
			if request, err = get(generation, "request", nil); err != nil {
				return err
			}
		}
		requestDict, ok := request.(*toolrt.Dict)
		if !ok || !toolrt.Truthy(requestDict.Value("path")) {
			continue
		}
		location, isString := requestDict.Value("path").(string)
		if !isString {
			return pathOperandError(requestDict.Value("path"))
		}
		snapshot, err := toolrt.RelativeTo(toolrt.JoinPath(filepath.Dir(manifest), location), root)
		if err != nil {
			return err
		}
		if err := lintSnapshot(root, snapshot, r); err != nil {
			return err
		}
	}
	return nil
}

// lintPackages — workflow.json и request.json пакетов plan/awaiting и plan/batches.
func lintPackages(root string, r *Report) error {
	folders := []string{}
	for _, base := range []string{"awaiting", "batches"} {
		entries := toolrt.Glob(toolrt.JoinPath(root, "plan", base), "*")
		toolrt.SortPaths(entries)
		for _, entry := range entries {
			if toolrt.IsDir(entry) {
				folders = append(folders, entry)
			}
		}
	}
	for _, folder := range folders {
		workflow := toolrt.JoinPath(folder, "workflow.json")
		if toolrt.IsFile(workflow) {
			name, err := toolrt.RelativeTo(workflow, root)
			if err != nil {
				return err
			}
			data, err := readJSON(root, name, r)
			if err != nil {
				return err
			}
			if data != nil {
				for _, message := range validateSchema(data, "workflow") {
					r.schemaError(name, message)
				}
				if document, ok := data.(*toolrt.Dict); ok && toolrt.PathName(filepath.Dir(folder)) == "awaiting" {
					found, _ := toolrt.Contains(awaitingStages, document.Value("stage"))
					if !found {
						r.error(name, "stage", textAwaitingStage)
					}
				}
			}
		}
		requests := append(toolrt.Glob(folder, "request.json"), toolrt.Glob(folder, "*/request.json")...)
		for _, request := range requests {
			name, err := toolrt.RelativeTo(request, root)
			if err != nil {
				return err
			}
			data, err := readJSON(root, name, r)
			if err != nil {
				return err
			}
			if data != nil {
				for _, message := range validateSchema(data, "request") {
					r.schemaError(name, message)
				}
			}
		}
	}
	return nil
}

// lintProductionStatus — форма отпечатков принятия и их планы.
func lintProductionStatus(root string, data any, r *Report) error {
	value, err := readJSON(root, sceneregistry.ProductionStatus, r)
	if err != nil {
		return err
	}
	status, ok := value.(*toolrt.Dict)
	if !ok {
		if value != nil {
			r.error(sceneregistry.ProductionStatus, "$", textStatusObject)
		}
		return nil
	}
	accepted, err := sceneregistry.AcceptedFingerprints(status)
	if toolrt.Is(err, toolrt.ValueError) {
		r.error(sceneregistry.ProductionStatus, "shots", strings.TrimPrefix(err.Error(), sceneregistry.ProductionStatus+": "))
		return nil
	}
	if err != nil {
		return err
	}
	ids := toolrt.NewSet()
	if document, isDict := data.(*toolrt.Dict); isDict {
		scenesValue, _ := get(document, "scenes", []any{})
		scenes, err := toolrt.Iter(scenesValue)
		if err != nil {
			return err
		}
		for _, scene := range scenes {
			if entry, ok := scene.(*toolrt.Dict); ok {
				if err := ids.Add(entry.Value("id")); err != nil {
					return err
				}
			}
		}
	}
	for _, sid := range accepted.Keys() {
		if !ids.Contains(sid) {
			r.warning(sceneregistry.ProductionStatus, "shots."+sid, textAcceptedNoScene)
		} else if !toolrt.IsFile(toolrt.JoinPath(root, "assets", "shots", sid, "manifest.json")) {
			r.warning(sceneregistry.ProductionStatus, "shots."+sid, textAcceptedNoKit)
		}
	}
	return nil
}

// Lint — полный отчёт проекта. Ошибка — необработанное исключение toolrt (строка «Ошибка: …» и код 1
// в выводе инструмента).
func Lint(root string) (*Report, error) {
	r := &Report{}
	data, err := lintScenes(root, r)
	if err != nil {
		return nil, err
	}
	if err := lintCast(root, data, r); err != nil {
		return nil, err
	}
	if err := lintDescription(root, data, r); err != nil {
		return nil, err
	}
	if err := lintAssets(root, r); err != nil {
		return nil, err
	}
	if err := lintProductionStatus(root, data, r); err != nil {
		return nil, err
	}
	if err := lintPackages(root, r); err != nil {
		return nil, err
	}
	return r, nil
}

// render — текстовый отчёт: строки ошибок, затем предупреждений, затем итог.
func render(r *Report) string {
	lines := []string{}
	for _, entry := range append(append([]item{}, r.Errors...), r.Warnings...) {
		level := "предупреждение"
		if entry.level == "error" {
			level = "ОШИБКА"
		}
		lines = append(lines, level+"  "+entry.file+" · "+entry.where+": "+entry.message)
	}
	lines = append(lines, "Ошибок: "+itoa(len(r.Errors))+", предупреждений: "+itoa(len(r.Warnings))+".")
	return strings.Join(lines, "\n")
}

func itoa(value int) string { return toolrt.NewInt(int64(value)).String() }

// records — записи отчёта как словари {level, file, where, message}.
func records(items []item) []any {
	result := make([]any, len(items))
	for index, entry := range items {
		result[index] = toolcli.Record("level", entry.level, "file", entry.file, "where", entry.where, "message", entry.message)
	}
	return result
}

// Run — запуск инструмента на разрешённом корне проекта: отчёт текстом или JSON, код 1 при
// ошибках (и предупреждениях с --strict).
func Run(root string, args []string) toolcli.Output {
	parsed, exit := toolcli.Args(Parser, args)
	if exit != nil {
		return *exit
	}
	printer := &toolcli.Printer{}
	report, err := Lint(root)
	if err != nil {
		return printer.Crash(err)
	}
	text := render(report)
	if parsed.Bools["--json"] {
		if text, err = toolcli.JSON(toolcli.Record("errors", records(report.Errors), "warnings", records(report.Warnings))); err != nil {
			return printer.Crash(err)
		}
	}
	if err := printer.Print(text); err != nil {
		return printer.Crash(err)
	}
	if len(report.Errors) > 0 || (parsed.Bools["--strict"] && len(report.Warnings) > 0) {
		return printer.Exit(1)
	}
	return printer.Exit(0)
}
