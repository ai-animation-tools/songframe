package projectviews

import (
	"math/big"
	"sort"
	"strings"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/sceneregistry"
)

// Prepared — prepared(sources): проверенный реестр, его планы с монтажным временем (Shots) и
// манифесты технических комплектов assets/shots/<план>/manifest.json, которые есть в проекте
// (код плана → разобранный JSON, в порядке планов). Initial — начальное состояние кастинга, с
// которым проверялся реестр (initial_states_for проекта).
type Prepared struct {
	Data     *pycompat.Dict
	Items    []*pycompat.Dict
	Packages *pycompat.Dict
	Initial  *pycompat.Dict
}

// Prepare — prepared(sources). Оригинал вызывает его несколько раз за запуск; результат при
// неизменных файлах тот же, поэтому вызывающий может вычислить его один раз.
func Prepare(sources *Sources) (*Prepared, error) {
	raw, err := sources.JSON("plan/scenes.json")
	if err != nil {
		return nil, err
	}
	initial, err := sceneregistry.InitialStatesFor(sources.Root)
	if err != nil {
		return nil, err
	}
	data, err := sceneregistry.Validate(raw, initial)
	if err != nil {
		return nil, err
	}
	shots, err := sceneregistry.Shots(data, initial)
	if err != nil {
		return nil, err
	}
	packages := pycompat.NewDict()
	for _, scene := range shots {
		sid := scene.Value("id").(string)
		path := "assets/shots/" + sid + "/manifest.json"
		if sources.Has(path) {
			manifest, err := sources.JSON(path)
			if err != nil {
				return nil, err
			}
			packages.Set(sid, manifest)
		}
	}
	return &Prepared{Data: data, Items: shots, Packages: packages, Initial: initial}, nil
}

// ProjectInputs — project_inputs(project, animatic): значимые поля проекта для карточек (name)
// или сборки аниматика (name и animatic_video). Отсутствующее поле — KeyError.
func ProjectInputs(project any, animatic bool) (*pycompat.Dict, error) {
	keys := []string{"name"}
	if animatic {
		keys = append(keys, "animatic_video")
	}
	result := pycompat.NewDict()
	for _, key := range keys {
		value, err := get(project, key)
		if err != nil {
			return nil, err
		}
		result.Set(key, value)
	}
	return result, nil
}

// ProjectInputsMatch — project_inputs_match(record, project, animatic): снимок полей проекта в
// квитанции совпадает с текущими; отсутствующий или повреждённый снимок требует обновления.
func ProjectInputsMatch(record, project any, animatic bool) (bool, error) {
	found, err := pycompat.Contains(record, "project_inputs")
	if err != nil || !found {
		return false, err
	}
	saved, _ := pycompat.GetItem(record, "project_inputs")
	expected, err := ProjectInputs(project, animatic)
	if err != nil {
		return false, err
	}
	dict, ok := saved.(*pycompat.Dict)
	if !ok || dict.Len() != expected.Len() {
		return false, nil
	}
	for _, key := range expected.Keys() {
		if !dict.Has(key) {
			return false, nil
		}
	}
	for _, key := range dict.Keys() {
		if _, isString := dict.Value(key).(string); !isString {
			return false, nil
		}
	}
	return pycompat.Equal(dict, expected), nil
}

// banner — общая плашка производных документов (format с относительной ссылкой на реестр).
func banner(registry string) string {
	return "> Автоматическое представление [plan/scenes.json](" + registry + "). " +
		"Изменять только реестр; этот файл не является отдельным " +
		"источником постановки.\n"
}

// Document — производный файл проекта: путь от корня и ожидаемый текст.
type Document struct {
	Path string
	Text string
}

// Documents — documents(sources): ожидаемые тексты производных документов в порядке оригинала
// (монтажный список, раскадровка, индекс комплектов, ROADMAP, справочник, README комплектов,
// разметка трека) после обрезки пробелов в конце строк. Порядок задаёт порядок сообщений
// «Устарели представления».
func Documents(sources *Sources, prepared *Prepared) ([]Document, error) {
	project, err := projectFile(sources)
	if err != nil {
		return nil, err
	}
	name := pycompat.Str(project.Value("name"))
	edit, err := editList(prepared, name)
	if err != nil {
		return nil, err
	}
	story, err := storyboard(prepared, name)
	if err != nil {
		return nil, err
	}
	index, err := packagesIndex(sources, prepared)
	if err != nil {
		return nil, err
	}
	roadmap, err := Render(sources, prepared)
	if err != nil {
		return nil, err
	}
	output := []Document{
		{"plan/edit-list.md", edit},
		{"plan/storyboard.md", story},
		{"assets/shots/manifest.json", index},
		{"ROADMAP.md", roadmap},
	}
	characters, err := charactersView(prepared)
	if err != nil {
		return nil, err
	}
	output = append(output, Document{"plan/context/characters.md", characters})
	for _, scene := range prepared.Items {
		sid := scene.Value("id").(string)
		if !prepared.Packages.Has(sid) {
			continue
		}
		readme, err := packageReadme(sid, prepared.Packages.Value(sid))
		if err != nil {
			return nil, err
		}
		output = append(output, Document{"assets/shots/" + sid + "/README.md", readme})
	}
	timing, err := timingView(sources)
	if err != nil {
		return nil, err
	}
	output = append(output, Document{"plan/audio/timing.md", timing})
	for index := range output {
		output[index].Text = rstripLines(output[index].Text)
	}
	return output, nil
}

// projectFile — validate_project(sources.json("plan/project.json"), validate_generation=False):
// представлениям нужны только название и имя аниматика, настройки генерации не проверяются.
func projectFile(sources *Sources) (*pycompat.Dict, error) {
	raw, err := sources.JSON("plan/project.json")
	if err != nil {
		return nil, err
	}
	return sceneregistry.ValidateProject(raw, false)
}

// editList — plan/edit-list.md: таблица планов с исходным планом, интервалом, камерой, действием,
// непрерывностью и референсами.
func editList(prepared *Prepared, name string) (string, error) {
	columns := []string{"План", "Исходный план", "Начало → конец", "Секунды", "Крупность и камера", "Действие", "Непрерывность", "Референсы"}
	separators := make([]string, len(columns))
	for index := range separators {
		separators[index] = "---"
	}
	lines := []string{
		"# Монтажный список клипа «" + name + "»",
		"",
		banner("scenes.json"),
		"| " + strings.Join(columns, " | ") + " |",
		"| " + strings.Join(separators, " | ") + " |",
	}
	for _, scene := range prepared.Items {
		label, err := DerivedLabel(scene, " · ")
		if err != nil {
			return "", err
		}
		values := []any{scene.Value("id").(string) + label}
		for _, key := range []string{"original", "interval", "duration", "camera", "action", "continuity"} {
			value, err := get(scene, key)
			if err != nil {
				return "", err
			}
			values = append(values, value)
		}
		references, err := get(scene, "references")
		if err != nil {
			return "", err
		}
		list, err := pycompat.Iter(references)
		if err != nil {
			return "", err
		}
		joined, err := join(" ", list)
		if err != nil {
			return "", err
		}
		values = append(values, joined)
		cells := make([]string, len(values))
		for index, value := range values {
			cells[index] = Cell(value)
		}
		lines = append(lines, "| "+strings.Join(cells, " | ")+" |")
	}
	return strings.Join(lines, "\n") + "\n", nil
}

// storyboard — plan/storyboard.md: разделы частей и планов с монтажом, камерой, действием,
// непрерывностью, заметками, источником состояния и локальными изменениями (без полной копии
// вычисленного состояния).
func storyboard(prepared *Prepared, name string) (string, error) {
	story := []any{
		"# Постановка сцен клипа «" + name + "»",
		"",
		banner("scenes.json"),
		"Общая история — в [сценарии](../source/description.md); " +
			"роли, внешность и начальное состояние персонажей — в кастинге " +
			"[plan/cast.json](cast.json) (страница «Кастинг»); общие визуальные " +
			"правила и речевые планы — в [визуальном справочнике](context/characters.md).",
		"",
	}
	sequences, err := pycompat.Iter(prepared.Data.Value("sequences"))
	if err != nil {
		return "", err
	}
	for _, group := range sequences {
		groupID, err := get(group, "id")
		if err != nil {
			return "", err
		}
		members := []*pycompat.Dict{}
		for _, scene := range prepared.Items {
			if pycompat.Equal(scene.Value("sequence"), groupID) {
				members = append(members, scene)
			}
		}
		if len(members) == 0 {
			continue
		}
		var heading any = "Вступление"
		if !pycompat.Equal(groupID, "intro") {
			if heading, err = pycompat.Add("Сцена ", groupID); err != nil {
				return "", err
			}
		}
		title, err := get(group, "title")
		if err != nil {
			return "", err
		}
		line, err := concat("## ", heading, ". ", title)
		if err != nil {
			return "", err
		}
		direction, err := get(group, "direction")
		if err != nil {
			return "", err
		}
		story = append(story, line, "", direction, "")
		for _, scene := range members {
			lines, err := storyScene(scene)
			if err != nil {
				return "", err
			}
			story = append(story, lines...)
		}
	}
	return join("\n", story)
}

// storyScene — раздел одного плана раскадровки.
func storyScene(s *pycompat.Dict) ([]any, error) {
	sid := s.Value("id").(string)
	fields := map[string]any{}
	for _, key := range []string{"title", "interval", "duration"} {
		value, err := get(s, key)
		if err != nil {
			return nil, err
		}
		fields[key] = value
	}
	story := []any{
		`<a id="` + strings.ToLower(sid) + `"></a>`,
		"### " + sid + ". " + pycompat.Str(fields["title"]),
		"",
		"**Монтаж:** " + pycompat.Str(fields["interval"]) + " · " + pycompat.Str(fields["duration"]) + " с.",
		"",
	}
	if derived := s.Value("derived_from"); pycompat.Truthy(derived) {
		origin, err := get(derived, "shot")
		if err != nil {
			return nil, err
		}
		lowered, err := lower(origin)
		if err != nil {
			return nil, err
		}
		story = append(story, "**Материал:** из ["+pycompat.Str(origin)+"](#"+lowered+"), без собственной генерации.", "")
	}
	camera, err := get(s, "camera")
	if err != nil {
		return nil, err
	}
	story = append(story, "**Камера:** "+pycompat.Str(camera), "")
	action, err := get(s, "action")
	if err != nil {
		return nil, err
	}
	story = append(story, action, "")
	continuity, err := get(s, "continuity")
	if err != nil {
		return nil, err
	}
	notes, _ := pycompat.DictGet(s, "notes", "")
	story = append(story, "**Непрерывность:** "+pycompat.Str(continuity), "", notes, "")
	// Источник состояния: план (строка) или {scene, phase}; ссылка на сводку, а не её копия.
	source := s.Value("state_from")
	origin, phase := source, any("after")
	if dict, ok := source.(*pycompat.Dict); ok {
		origin = dict.Value("scene")
		phase, _ = pycompat.DictGet(dict, "phase", "after")
	}
	link := "начало сюжетной линии"
	if pycompat.Truthy(origin) {
		lowered, err := lower(origin)
		if err != nil {
			return nil, err
		}
		link = "[" + pycompat.Str(origin) + "](#" + lowered + ") (" + pycompat.Str(phase) + ")"
	}
	story = append(story, "**Состояние:** "+link+"; сводку до/после получить инструментом `scene_registry` комплекса.", "")
	changesValue, _ := pycompat.DictGet(s, "state_changes", pycompat.NewDict())
	changes, err := items(changesValue)
	if err != nil {
		return nil, err
	}
	for _, moment := range changes.Keys() {
		delta, err := items(changes.Value(moment))
		if err != nil {
			return nil, err
		}
		facts := []string{}
		for _, entity := range delta.Keys() {
			attributes, err := items(delta.Value(entity))
			if err != nil {
				return nil, err
			}
			for _, key := range attributes.Keys() {
				value := attributes.Value(key)
				text := "не задано"
				if value != nil {
					text = pycompat.Str(value)
				}
				facts = append(facts, entity+"."+key+": "+text)
			}
		}
		story = append(story, "**Изменения "+moment+":** "+strings.Join(facts, "; "), "")
	}
	return story, nil
}

// packagesIndex — assets/shots/manifest.json: индекс комплектов с SHA-256 текста их манифестов.
func packagesIndex(sources *Sources, prepared *Prepared) (string, error) {
	shots := pycompat.NewDict()
	for _, sid := range prepared.Packages.Keys() {
		path := "assets/shots/" + sid + "/manifest.json"
		digest, err := sources.TextSHA(path)
		if err != nil {
			return "", err
		}
		manifest := pycompat.NewDict()
		manifest.Set("path", path)
		manifest.Set("sha256", digest)
		entry := pycompat.NewDict()
		entry.Set("asset_manifest", manifest)
		shots.Set(sid, entry)
	}
	index := pycompat.NewDict()
	index.Set("schema_version", pycompat.NewInt(2))
	index.Set("description", "Автоматический индекс локальных технических комплектов; постановка и тайминг принадлежат plan/scenes.json.")
	index.Set("shots", shots)
	text, err := pycompat.DumpsJSON(index, pycompat.DumpOptions{Indent: 2, Pretty: true})
	if err != nil {
		return "", err
	}
	return text + "\n", nil
}

// charactersView — plan/context/characters.md: общие визуальные правила реестра и список речевых
// планов, выведенный из флага lipsync (отдельная копия правил и ручной список не нужны).
func charactersView(prepared *Prepared) (string, error) {
	speech := []string{}
	for _, scene := range prepared.Items {
		if pycompat.Truthy(scene.Value("lipsync")) {
			sid := scene.Value("id").(string)
			speech = append(speech, "["+sid+"](../storyboard.md#"+strings.ToLower(sid)+")")
		}
	}
	view := "\n\n## Речевые планы\n\nРечевые планы не назначены.\n"
	if len(speech) > 0 {
		view = "\n\n## Речевые планы\n\nВсего " + pycompat.NewInt(int64(len(speech))).String() + ". " + strings.Join(speech, ", ") + ".\n"
	}
	visual, err := get(prepared.Data, "visual_direction")
	if err != nil {
		return "", err
	}
	text, ok := visual.(string)
	if !ok {
		return "", pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'strip'", pycompat.TypeName(visual))
	}
	return banner("../scenes.json") + "\n" + pycompat.Strip(text) + view, nil
}

// packageReadme — assets/shots/<план>/README.md: ссылки на оригинал, принятый монтаж, промпт и
// аудио липсинка комплекта и его кадровые параметры.
func packageReadme(sid string, manifest any) (string, error) {
	generation, err := get(manifest, "generation")
	if err != nil {
		return "", err
	}
	edit, err := get(manifest, "accepted_edit")
	if err != nil {
		return "", err
	}
	link := func(title string, container any, keys ...string) (string, error) {
		path, err := getPath(container, keys...)
		if err != nil {
			return "", err
		}
		return "[" + title + "](" + pycompat.Str(path) + ")", nil
	}
	links := []string{}
	for _, item := range []struct {
		title     string
		container any
		keys      []string
	}{
		{"Полный оригинал", generation, []string{"original", "path"}},
		{"Принятый монтаж", edit, []string{"video", "path"}},
		{"Промпт", generation, []string{"prompt", "path"}},
	} {
		text, err := link(item.title, item.container, item.keys...)
		if err != nil {
			return "", err
		}
		links = append(links, text)
	}
	audio, err := dictGet(generation, "audio", nil)
	if err != nil {
		return "", err
	}
	if pycompat.Truthy(audio) {
		text, err := link("Аудио липсинка", generation, "audio", "path")
		if err != nil {
			return "", err
		}
		links = append(links, text)
	}
	frames, err := get(edit, "frames")
	if err != nil {
		return "", err
	}
	fps, err := get(edit, "fps")
	if err != nil {
		return "", err
	}
	return "# " + sid + " — технический комплект\n\n> Автоматическое " +
		"представление. Постановка и тайминг — только в [реестре " +
		"сцен](../../../plan/scenes.json) и его " +
		"[представлении](../../../plan/storyboard.md#" + strings.ToLower(sid) + ").\n\n" +
		strings.Join(links, " · ") +
		"\n\n[manifest.json](manifest.json) хранит файлы, хеши и рецепт " +
		"обработки генерации. Принятый клип: " + pycompat.Str(frames) + " кадров при " +
		pycompat.Str(fps) + " кадр/с. Положение на шкале клипа в ассете не " +
		"дублируется.\n", nil
}

// clockOf — clock(str(value)): время поля разметки строкой «ММ:СС.d» через Decimal(str()).
func clockOf(value any) (string, error) {
	return sceneregistry.Clock(pycompat.Str(value))
}

// timingView — plan/audio/timing.md: структура песни и оценки строк вокала из plan/audio/timing.json.
func timingView(sources *Sources) (string, error) {
	audio, err := sources.JSON("plan/audio/timing.json")
	if err != nil {
		return "", err
	}
	status, err := get(audio, "status")
	if err != nil {
		return "", err
	}
	timing := []any{
		"# Речевые и музыкальные оценки",
		"",
		"> Автоматическое представление [timing.json](timing.json). Эти " +
			"оценки не задают монтажные границы: они принадлежат [реестру " +
			"сцен](../scenes.json).",
		"",
		status,
		"",
		"## Структура песни",
		"",
		"| Часть | Начало | Конец | Примечание |",
		"| --- | --- | --- | --- |",
	}
	row := func(item any, before []string, after []string) (string, error) {
		values := []any{}
		for _, key := range before {
			if key == "source_line" {
				value, err := dictGet(item, key, "")
				if err != nil {
					return "", err
				}
				values = append(values, value)
				continue
			}
			value, err := get(item, key)
			if err != nil {
				return "", err
			}
			values = append(values, value)
		}
		for _, key := range []string{"start", "end"} {
			value, err := get(item, key)
			if err != nil {
				return "", err
			}
			text, err := clockOf(value)
			if err != nil {
				return "", err
			}
			values = append(values, text)
		}
		for _, key := range after {
			value, err := dictGet(item, key, "")
			if err != nil {
				return "", err
			}
			values = append(values, value)
		}
		cells := make([]string, len(values))
		for index, value := range values {
			cells[index] = Cell(value)
		}
		return "| " + strings.Join(cells, " | ") + " |", nil
	}
	sections, err := get(audio, "sections")
	if err != nil {
		return "", err
	}
	list, err := pycompat.Iter(sections)
	if err != nil {
		return "", err
	}
	for _, item := range list {
		line, err := row(item, []string{"name"}, []string{"note"})
		if err != nil {
			return "", err
		}
		timing = append(timing, line)
	}
	timing = append(timing,
		"",
		"## Оценки строк вокала",
		"",
		"| ID | Строка исходного текста | Начало | Конец | Ограничения оценки |",
		"| --- | --- | --- | --- | --- |",
	)
	lines, err := get(audio, "lines")
	if err != nil {
		return "", err
	}
	if list, err = pycompat.Iter(lines); err != nil {
		return "", err
	}
	for _, item := range list {
		line, err := row(item, []string{"id", "source_line"}, []string{"note"})
		if err != nil {
			return "", err
		}
		timing = append(timing, line)
	}
	timing = append(timing,
		"",
		"Точный текст — [source/text.md](../../source/text.md), исходное "+
			"аудио — [source/track.mp3](../../source/track.mp3). Анализ "+
			"выполняет инструмент `transcribe_local` комплекса; временные "+
			"результаты сохранять вне папки проекта, во временной папке ОС. Слуховые поправки "+
			"и новые оценки вносить в timing.json; постановку сцен здесь не "+
			"повторять.",
		"",
	)
	return join("\n", timing)
}

// sumFrames — sum(s["frames"] for s in items): кадры планов (целые из Shots).
func sumFrames(items []*pycompat.Dict, include func(*pycompat.Dict) bool) *big.Int {
	total := new(big.Int)
	for _, scene := range items {
		if include == nil || include(scene) {
			total.Add(total, scene.Value("frames").(pycompat.Int).Big())
		}
	}
	return total
}

// sortedKeys — ключи словаря по алфавиту (для детерминированного обхода множеств оригинала).
func sortedKeys(dict *pycompat.Dict) []string {
	keys := dict.Keys()
	sort.Strings(keys)
	return keys
}
