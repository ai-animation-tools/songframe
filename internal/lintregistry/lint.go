// Package lintregistry проверяет plan/scenes.json, кастинг, описание, комплекты assets, файл
// принятия и рабочие пакеты по встроенным JSON-схемам (подмножество JSON Schema) и правилам
// владения сведениями (хроника принятий и технические рецепты не хранятся в постановке).
//
// Вывод зафиксирован эталоном testdata/golden/lint-registry: строки «ОШИБКА/предупреждение  файл · место: текст»
// и итог, либо JSON {errors, warnings} с --json; код 1 при ошибках (и предупреждениях с --strict).
// Данные неожиданной формы дают те же исключения Python (трассировка, код 1). Пакет только читает
// файлы проекта; схемы встроены в бинарник, регулярные выражения — internal/pyre (семантика re).
package lintregistry

import (
	"embed"
	"path/filepath"
	"runtime"
	"sort"
	"strings"

	"songframe-go/internal/castregistry"
	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pyre"
	"songframe-go/internal/pytool"
	"songframe-go/internal/sceneregistry"
)

//go:embed schemas/*.schema.json
var schemaFiles embed.FS

// Parser — разбор аргументов lint_registry; Prog и описание видны в справке и ошибках разбора.
var Parser = pycompat.ArgParser{
	Prog:        "lint_registry.py",
	Description: "Проверка реестра, комплектов и пакетов по схемам и правилам владения сведениями; @link README.md",
	Flags: []pycompat.Flag{
		{Name: "--json"},
		{Name: "--strict", Help: "Предупреждения тоже считать ошибками"},
	},
}

// productionWords — PRODUCTION_WORDS: слова производства в постановке.
const productionWords = `(проб|участ|клип|генерац|склейк|переход|видео|кадр|монтаж|обрезк|включ|версия|v\d)`

// historyPattern — шаблон HISTORY_PATTERNS и подпись найденного.
type historyPattern struct {
	pattern *pyre.Regexp
	label   string
}

// historyPatterns — HISTORY_PATTERNS (re.I): хроника принятий и технические рецепты.
var historyPatterns = []historyPattern{
	{pyre.MustCompile(`(?:`+productionWords+`[^.;]{0,60}\bприняты?\b)|(?:\bприняты?\b[^.;]{0,60}`+productionWords+`)|\bпринята (новая|генерация|обрезка)`, pyre.IgnoreCase), "факт принятия"},
	{pyre.MustCompile(`\bвключен[аоы]? в v\d+`, pyre.IgnoreCase), "ссылка на версию аниматика"},
	{pyre.MustCompile(`(?<![\w_-])v\d{2}\b`, pyre.IgnoreCase), "номер версии"},
	{pyre.MustCompile(`\bв пробе\b|\bпроба [A-ZМ]\d`, pyre.IgnoreCase), "упоминание пробы"},
	{pyre.MustCompile(`assets/shots/`, pyre.IgnoreCase), "путь в assets"},
	{pyre.MustCompile(`manifest\.json`, pyre.IgnoreCase), "ссылка на технический файл"},
	{pyre.MustCompile(`\bархив`, pyre.IgnoreCase), "упоминание архива"},
	{pyre.MustCompile(`\bпрежн(яя|ий|ие|его|ей) верси`, pyre.IgnoreCase), "прежняя версия"},
	{pyre.MustCompile(`\bоригинал[а-я]* \d|\bучаст(ок|ка) \d|\d[,.]\d+\s*×|\bна 1×|\bускорен[а-я]* на|\bзамедлен[а-я]* до|\d+/\d+\s*≈|\b\d+ кадр(а|ов)? (на|при) \d`, pyre.IgnoreCase), "технический рецепт монтажа"},
	{pyre.MustCompile(`\b(оригинал|клип|видео|версия|кандидат)[^.;]{0,40}\bсохран(ён|ены|ена|ено)\b`, pyre.IgnoreCase), "факт сохранения"},
}

var (
	// markdownLink — r"\]\(([^)]+)\)": цель ссылки Markdown.
	markdownLink = pyre.MustCompile(`\]\(([^)]+)\)`, 0)
	// imageLink — r"\.(png|jpe?g|webp)$" (re.I).
	imageLink = pyre.MustCompile(`\.(png|jpe?g|webp)$`, pyre.IgnoreCase)
	// derivedLinks — DERIVED_LINKS: производные представления.
	derivedLinks = pyre.MustCompile(`edit-list\.md|production-status\.json|storyboard\.md|ROADMAP\.md`, 0)
)

// snapshotForbidden — SNAPSHOT_FORBIDDEN: служебные поля, которые не хранятся в снимке assets.
var snapshotForbidden = map[string]bool{
	"prepared_at": true, "account_checked_at": true, "cost": true, "available_credits": true, "video_submitted": true,
	"result_saved": true, "status": true, "notes": true, "revision": true, "revision_reason": true, "stage": true,
	"attempt": true, "cli_version": true, "approved_at": true, "approval": true, "created_at": true, "updated_at": true,
	"saved_at": true, "submitted_at": true, "submission_started_at": true, "downloaded_at": true, "last_query_at": true,
	"capabilities_checked_at": true, "balance": true, "pricing": true, "credits_consumed": true, "creditsConsumed": true,
	"download_status": true, "service_statuses": true, "submitted": true, "uploaded": true,
}

// snapshotAliases — SNAPSHOT_ALIASES в порядке объявления: каноническое имя и устаревшие формы.
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
	textReferencesDrift  = "карта references расходится с кастингом: python3 -B tools/cast_registry/cast_registry.py sync"
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

// readJSON — read_json(root, name, report): отсутствующий файл — nil; ValueError (JSON, UTF-8)
// — ошибка отчёта и nil; прочие ошибки чтения (каталог, права) — исключение.
func readJSON(root, name string, r *Report) (any, error) {
	value, err := pycompat.LoadJSONFile(pycompat.JoinPath(root, name))
	switch {
	case err == nil:
		return value, nil
	case pycompat.Is(err, pycompat.FileNotFoundError):
		return nil, nil
	case pycompat.Is(err, pycompat.ValueError):
		r.error(name, "$", "JSON не разбирается: "+err.Error())
		return nil, nil
	}
	return nil, err
}

// expectString — аргумент re.* должен быть строкой, иначе TypeError, как в Python.
func expectString(value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", pycompat.Raise(pycompat.TypeError, "expected string or bytes-like object, got '%s'", pycompat.TypeName(value))
	}
	return text, nil
}

// historyHits — history_hits(text): найденные признаки хроники с контекстом ±30 символов.
func historyHits(value any) ([]string, error) {
	text, err := expectString(value)
	if err != nil {
		return nil, err
	}
	runes := pycompat.Runes(text)
	hits := []string{}
	for _, entry := range historyPatterns {
		match, ok := entry.pattern.Search(text)
		if !ok {
			continue
		}
		start := max(0, match.Start()-30)
		end := min(len(runes), match.End()+30)
		hits = append(hits, entry.label+": «…"+pycompat.Strip(pycompat.FromRunes(runes[start:end]))+"…»")
	}
	return hits, nil
}

// links — цели ссылок Markdown (group(1) re.finditer).
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

// get — value.get(key, fallback) с AttributeError для не-словаря.
func get(value any, key string, fallback any) (any, error) {
	return pycompat.DictGet(value, key, fallback)
}

// lintScenes — lint_scenes: схема, ссылки и хроника в постановке, референсы и derived_from.
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
	document, ok := data.(*pycompat.Dict)
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
	sequences, err := pycompat.Iter(sequencesValue)
	if err != nil {
		return nil, err
	}
	for _, sequence := range sequences {
		id, err := get(sequence, "id", nil)
		if err != nil {
			return nil, err
		}
		where := "sequences[" + pycompat.Str(id) + "].direction"
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
	referencesValue, _ := get(document, "references", pycompat.NewDict())
	referenceKeys, err := pycompat.SetOf(referencesValue)
	if err != nil {
		return nil, err
	}
	scenesValue, _ := get(document, "scenes", []any{})
	scenes, err := pycompat.Iter(scenesValue)
	if err != nil {
		return nil, err
	}
	for _, scene := range scenes {
		sidValue, err := get(scene, "id", "?")
		if err != nil {
			return nil, err
		}
		sid := pycompat.Str(sidValue)
		for _, field := range []string{"action", "continuity", "notes"} {
			text, _ := get(scene, field, "")
			if !pycompat.Truthy(text) {
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
		keys, err := pycompat.Iter(keysValue)
		if err != nil {
			return nil, err
		}
		for _, key := range keys {
			if pycompat.Equal(key, "—") {
				continue
			}
			found, err := referenceKeys.Has(key)
			if err != nil {
				return nil, err
			}
			if !found {
				r.error(sceneregistry.ScenesPath, sid+".references", "неизвестный референс "+pycompat.Str(key))
			}
		}
		card, _ := get(scene, "card", pycompat.NewDict())
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
			r.error(sceneregistry.ScenesPath, pycompat.Str(problem.Shot)+".derived_from", message)
		}
	}
	return data, nil
}

// castReferences — references(cast) для сверки с реестром. KeyError и TypeError перехватываются
// (ok=false — сверка пропускается), AttributeError (сущность не словарь) — нет.
// nonString — у сущности с изображением нестроковый id: такой ключ не совпадёт с JSON-картой.
func castReferences(cast *pycompat.Dict) (result *pycompat.Dict, nonString, ok bool, err error) {
	result = pycompat.NewDict()
	entities, _ := cast.Value("entities").([]any)
	caught := func(err error) (*pycompat.Dict, bool, bool, error) {
		if pycompat.IsAny(err, pycompat.KeyError, pycompat.TypeError) {
			return nil, false, false, nil
		}
		return nil, false, false, err
	}
	for _, value := range entities {
		images, err := get(value, "images", nil)
		if err != nil {
			return caught(err)
		}
		if !pycompat.Truthy(images) {
			continue
		}
		entity := value.(*pycompat.Dict)
		name, err := pycompat.Item(entity, "name")
		if err != nil {
			return caught(err)
		}
		first, err := pycompat.GetItem(images, pycompat.NewInt(0))
		if err != nil {
			return caught(err)
		}
		path, err := pycompat.Add("source/", first)
		if err != nil {
			return caught(err)
		}
		reference := pycompat.NewDict()
		reference.Set("name", name)
		reference.Set("path", path)
		if short := entity.Value("short_name"); pycompat.Truthy(short) && !pycompat.Equal(short, name) {
			reference.Set("short_name", short)
		}
		id, err := pycompat.Item(entity, "id")
		if err != nil {
			return caught(err)
		}
		if _, err := pycompat.HashKey(id); err != nil {
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

// lintCast — lint_cast: необязательный plan/cast.json валиден и согласован с references реестра.
func lintCast(root string, scenes any, r *Report) error {
	if !pycompat.IsFile(pycompat.JoinPath(root, castregistry.CastPath)) {
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
	cast, isDict := data.(*pycompat.Dict)
	if !isDict {
		return nil
	}
	entities, isList := cast.Value("entities").([]any)
	if !isList {
		return nil
	}
	world := false
	for _, value := range entities {
		entity, ok := value.(*pycompat.Dict)
		if !ok {
			continue
		}
		imagesValue, _ := get(entity, "images", []any{})
		if !pycompat.Truthy(imagesValue) {
			imagesValue = []any{}
		}
		images, err := pycompat.Iter(imagesValue)
		if err != nil {
			return err
		}
		for _, image := range images {
			if text, isString := image.(string); isString && !pycompat.IsFile(pycompat.JoinPath(root, "source", text)) {
				r.error(castregistry.CastPath, pycompat.Str(entity.Value("id"))+".images", "нет файла source/"+text)
			}
		}
	}
	for _, value := range entities {
		if entity, ok := value.(*pycompat.Dict); ok && pycompat.Equal(entity.Value("kind"), "world") {
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
	if registry, isDict := scenes.(*pycompat.Dict); isDict {
		current := registry.Value("references")
		if nonString || !pycompat.Equal(current, derived) {
			r.error(sceneregistry.ScenesPath, "references", textReferencesDrift)
		}
	}
	return nil
}

// lintDescription — lint_description: герои реестра упомянуты в source/description.md.
func lintDescription(root string, data any, r *Report) error {
	path := pycompat.JoinPath(root, "source", "description.md")
	document, isDict := data.(*pycompat.Dict)
	if !pycompat.IsFile(path) || !isDict {
		return nil
	}
	text, err := pycompat.ReadText(path)
	if err != nil {
		return err
	}
	referencesValue, _ := get(document, "references", pycompat.NewDict())
	references, ok := referencesValue.(*pycompat.Dict)
	if !ok {
		return pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'items'", pycompat.TypeName(referencesValue))
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
			return pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'startswith'", pycompat.TypeName(pathValue))
		}
		if !strings.HasPrefix(location, "source/heroes/") || !pycompat.Truthy(name) {
			continue
		}
		title, isString := name.(string)
		if !isString {
			return pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'split'", pycompat.TypeName(name))
		}
		words := strings.FieldsFunc(title, pycompat.IsSpace)
		if len(words) == 0 {
			return pycompat.Raise(pycompat.IndexError, "list index out of range")
		}
		if !strings.Contains(text, words[0]) {
			r.warning("source/description.md", key, "персонаж «"+title+"» из реестра не упомянут в сценарии")
		}
	}
	return nil
}

// lintSnapshot — lint_snapshot: технический снимок запроса принятого комплекта.
func lintSnapshot(root, name string, r *Report) error {
	snapshot, err := readJSON(root, name, r)
	if err != nil || snapshot == nil {
		return err
	}
	keys, err := pycompat.SetOf(snapshot)
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
			found, err := pycompat.Contains(snapshot, candidate)
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
	model, err := pycompat.Contains(snapshot, "model")
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
		value, err := pycompat.GetItem(snapshot, key)
		if err != nil {
			return err
		}
		if value == nil {
			provenance, err := get(snapshot, "provenance", nil)
			if err != nil {
				return err
			}
			if !pycompat.Truthy(provenance) {
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
		warnings, err := warner.SnapshotWarnings(snapshot.(*pycompat.Dict))
		if err != nil {
			return err
		}
		for _, warning := range warnings {
			r.warning(name, warning.Where, warning.Message)
		}
	}
	return nil
}

// pathOperandError — TypeError оператора `/` pathlib для нестрокового компонента.
func pathOperandError(value any) error {
	class := "PosixPath"
	if runtime.GOOS == "windows" {
		class = "WindowsPath"
	}
	return pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: '%s' and '%s'", class, pycompat.TypeName(value))
}

// lintAssets — lint_assets: манифесты assets/shots/M*/manifest.json и их снимки запроса.
func lintAssets(root string, r *Report) error {
	manifests := pycompat.Glob(pycompat.JoinPath(root, "assets", "shots"), "M*/manifest.json")
	pycompat.SortPaths(manifests)
	for _, manifest := range manifests {
		name, err := pycompat.RelativeTo(manifest, root)
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
		if document, ok := packageValue.(*pycompat.Dict); ok {
			generation, _ := get(document, "generation", pycompat.NewDict())
			if request, err = get(generation, "request", nil); err != nil {
				return err
			}
		}
		requestDict, ok := request.(*pycompat.Dict)
		if !ok || !pycompat.Truthy(requestDict.Value("path")) {
			continue
		}
		location, isString := requestDict.Value("path").(string)
		if !isString {
			return pathOperandError(requestDict.Value("path"))
		}
		snapshot, err := pycompat.RelativeTo(pycompat.JoinPath(filepath.Dir(manifest), location), root)
		if err != nil {
			return err
		}
		if err := lintSnapshot(root, snapshot, r); err != nil {
			return err
		}
	}
	return nil
}

// lintPackages — lint_packages: workflow.json и request.json пакетов plan/awaiting и plan/batches.
func lintPackages(root string, r *Report) error {
	folders := []string{}
	for _, base := range []string{"awaiting", "batches"} {
		entries := pycompat.Glob(pycompat.JoinPath(root, "plan", base), "*")
		pycompat.SortPaths(entries)
		for _, entry := range entries {
			if pycompat.IsDir(entry) {
				folders = append(folders, entry)
			}
		}
	}
	for _, folder := range folders {
		workflow := pycompat.JoinPath(folder, "workflow.json")
		if pycompat.IsFile(workflow) {
			name, err := pycompat.RelativeTo(workflow, root)
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
				if document, ok := data.(*pycompat.Dict); ok && pycompat.PathName(filepath.Dir(folder)) == "awaiting" {
					found, _ := pycompat.Contains(awaitingStages, document.Value("stage"))
					if !found {
						r.error(name, "stage", textAwaitingStage)
					}
				}
			}
		}
		requests := append(pycompat.Glob(folder, "request.json"), pycompat.Glob(folder, "*/request.json")...)
		for _, request := range requests {
			name, err := pycompat.RelativeTo(request, root)
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

// lintProductionStatus — lint_production_status: форма отпечатков принятия и их планы.
func lintProductionStatus(root string, data any, r *Report) error {
	value, err := readJSON(root, sceneregistry.ProductionStatus, r)
	if err != nil {
		return err
	}
	status, ok := value.(*pycompat.Dict)
	if !ok {
		if value != nil {
			r.error(sceneregistry.ProductionStatus, "$", textStatusObject)
		}
		return nil
	}
	accepted, err := sceneregistry.AcceptedFingerprints(status)
	if pycompat.Is(err, pycompat.ValueError) {
		r.error(sceneregistry.ProductionStatus, "shots", strings.TrimPrefix(err.Error(), sceneregistry.ProductionStatus+": "))
		return nil
	}
	if err != nil {
		return err
	}
	ids := pycompat.NewSet()
	if document, isDict := data.(*pycompat.Dict); isDict {
		scenesValue, _ := get(document, "scenes", []any{})
		scenes, err := pycompat.Iter(scenesValue)
		if err != nil {
			return err
		}
		for _, scene := range scenes {
			if entry, ok := scene.(*pycompat.Dict); ok {
				if err := ids.Add(entry.Value("id")); err != nil {
					return err
				}
			}
		}
	}
	for _, sid := range accepted.Keys() {
		if !ids.Contains(sid) {
			r.warning(sceneregistry.ProductionStatus, "shots."+sid, textAcceptedNoScene)
		} else if !pycompat.IsFile(pycompat.JoinPath(root, "assets", "shots", sid, "manifest.json")) {
			r.warning(sceneregistry.ProductionStatus, "shots."+sid, textAcceptedNoKit)
		}
	}
	return nil
}

// Lint — полный отчёт проекта. Ошибка соответствует необработанному исключению Python
// (трассировка и код 1 в выводе инструмента).
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

func itoa(value int) string { return pycompat.NewInt(int64(value)).String() }

// records — записи отчёта как словари {level, file, where, message}.
func records(items []item) []any {
	result := make([]any, len(items))
	for index, entry := range items {
		result[index] = pytool.Record("level", entry.level, "file", entry.file, "where", entry.where, "message", entry.message)
	}
	return result
}

// Run — main() инструмента на разрешённом корне проекта.
func Run(root string, args []string) pytool.Output {
	parsed, exit := pytool.Args(Parser, args)
	if exit != nil {
		return *exit
	}
	printer := &pytool.Printer{}
	report, err := Lint(root)
	if err != nil {
		return printer.Crash(err)
	}
	text := render(report)
	if parsed.Bools["--json"] {
		if text, err = pytool.JSON(pytool.Record("errors", records(report.Errors), "warnings", records(report.Warnings))); err != nil {
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
