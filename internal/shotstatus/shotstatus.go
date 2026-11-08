// Package shotstatus — перенос tools/shot_status/shot_status.py замороженного оригинала: статусы
// планов по реестру сцен, выбранным комплектам assets, очереди plan/awaiting и рабочим попыткам
// plan/batches; кандидат next, таблица для человека, JSON для приложения и проверка независимости
// партии планов (--independent).
//
// Вывод совпадает с CLI оригинала на всех ветках: ожидаемые отказы (ValueError, OSError, KeyError)
// — текст в stderr и код 1, прочие исключения — трассировка. Пакет только читает файлы проекта.
package shotstatus

import (
	"sort"
	"strings"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/pyre"
	"songframe-go/internal/pytool"
	"songframe-go/internal/sceneregistry"
)

// Parser — argparse оригинала (описание — docstring модуля).
var Parser = pycompat.ArgParser{
	Prog:        "shot_status.py",
	Description: "Статусы планов по реестру, assets, очереди и рабочим попыткам; @link README.md",
	Flags: []pycompat.Flag{
		{Name: "--filter", Value: true, Choices: []string{"all", "planned", "progress", "completed", "stale", "unknown"}},
		{Name: "--json", Help: "Машиночитаемый вывод для приложения."},
		{Name: "--next", Help: "Только кандидат next и очередь."},
		{Name: "--independent", Plus: true, Metavar: "Mxx", Help: "Проверить независимость партии планов."},
	},
}

// statusOrder и statusLabels — STATUS_LABELS: порядок ключей задаёт порядок сводки таблицы.
var (
	statusOrder  = []string{"planned", "progress", "completed", "stale", "unknown"}
	statusLabels = map[string]string{
		"planned":   "запланирована",
		"progress":  "в работе",
		"completed": "готова",
		"stale":     "постановка изменена",
		"unknown":   "статус не установлен",
	}
)

// stageLabels — STAGE_LABELS: этапы workflow.json пакета.
var stageLabels = map[string]string{
	"description_review":   "описание на согласовании",
	"image_request_choice": "запрос изображения на подтверждении",
	"image_submitted":      "изображение генерируется",
	"image_downloaded":     "изображение получено, ожидает выбора",
	"keyframes_review":     "опоры на согласовании",
	"prompt_review":        "видеопромпт на согласовании",
	"request_choice":       "запрос на подтверждении",
	"ready":                "отложено в plan/awaiting",
	"awaiting":             "отложено в plan/awaiting",
	"needs_revision":       "требует исправления",
	"edit_review":          "генерация принята, монтажный участок не выбран",
	"accepted":             "принята, перенос в assets не завершён",
	"submitted":            "генерируется",
	"downloaded":           "результат получен, ожидает просмотра",
}

// attemptLabels — ATTEMPT_LABELS: состояния исполнения attempt.json.
var attemptLabels = map[string]string{
	"prepared":               "запрос на подтверждении",
	"submitting":             "исход отправки неизвестен",
	"submission_unknown":     "исход отправки неизвестен",
	"submitted":              "генерируется",
	"running":                "генерируется",
	"downloading":            "получение результата",
	"download_pending":       "получение результата",
	"watermark_free_pending": "получение результата без логотипа",
	"outputs_pending":        "получение результатов",
	"downloaded":             "результат получен, ожидает просмотра",
	"failed":                 "ошибка генерации, требует решения",
}

// waitLabels — WAIT_LABELS: причины отложенного пакета.
var waitLabels = map[string]string{
	"user_saved":              "отложено по решению пользователя",
	"insufficient_balance":    "нехватка средств",
	"cost_or_balance_unknown": "стоимость или баланс неизвестны",
}

// shotPrefix — SHOT_PREFIX: код плана в начале имени папки без учёта регистра.
var shotPrefix = pyre.MustCompile(`^(m\d{2}(?:\.\d+)?)(?![\d.])`, pyre.IgnoreCase)

// label — словарь_меток.get(key): только строковый ключ может совпасть со строковым ключом
// словаря, нехешируемый ключ (список, словарь) — TypeError, как у dict.get.
func label(labels map[string]string, key any) (string, bool, error) {
	if _, err := pycompat.HashKey(key); err != nil {
		return "", false, err
	}
	text, isString := key.(string)
	if !isString {
		return "", false, nil
	}
	found, ok := labels[text]
	return found, ok, nil
}

// document — результат read_json: значение, отсутствие файла (None) или повреждение (False;
// документ `false` Python тоже не отличает от повреждённого).
type document struct {
	value   any
	damaged bool
}

// readJSON — read_json(path) инструмента.
func readJSON(path string) document {
	value, damaged := pycompat.ReadJSON(path)
	return document{value: value, damaged: damaged}
}

// isFalse — `document is False`.
func (d document) isFalse() bool { return d.damaged || d.value == false }

// isNone — `document is None`.
func (d document) isNone() bool { return !d.damaged && d.value == nil }

// dict — документ-словарь или nil.
func (d document) dict() *pycompat.Dict {
	if d.damaged {
		return nil
	}
	result, _ := d.value.(*pycompat.Dict)
	return result
}

// pkg — состояние рабочего пакета: план (nil — не определён), подпись этапа, признак неизвестного
// состояния, вид (awaiting/batch) и путь от корня проекта.
type pkg struct {
	shot    any
	stage   string
	unknown bool
	kind    string
	path    string
}

// shotOf — shot_of(directory, workflow, request): поле shot документов или код в имени папки.
func shotOf(directory string, documents ...*pycompat.Dict) any {
	for _, document := range documents {
		if document == nil {
			continue
		}
		if shot, ok := document.Value("shot").(string); ok {
			return shot
		}
	}
	if match, ok := shotPrefix.Search(pycompat.PathName(directory)); ok {
		code, _ := match.Group(1)
		return strings.ToUpper(code)
	}
	return nil
}

// childPath — directory / value: строка или TypeError оператора «/» pathlib.
func childPath(directory string, value any) (string, error) {
	text, ok := value.(string)
	if !ok {
		return "", pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: 'PosixPath' and '%s'", pycompat.TypeName(value))
	}
	return pycompat.JoinPath(directory, text), nil
}

// packageState — package_state(directory): этап одного пакета очереди или попытки; nil — в папке
// нет ни одного документа пакета.
func packageState(directory string) (*pkg, error) {
	workflow := readJSON(pycompat.JoinPath(directory, "workflow.json"))
	// Свежий пакет хранит request_dir: null до заморозки запроса; это обычное состояние, а не ошибка.
	var requestName any
	if document := workflow.dict(); document != nil {
		requestName = document.Value("request_dir")
	}
	if !pycompat.Truthy(requestName) {
		requestName = "request"
	}
	requestDir, err := childPath(directory, requestName)
	if err != nil {
		return nil, err
	}
	attempt := readJSON(pycompat.JoinPath(requestDir, "attempt.json"))
	if attempt.isNone() {
		attempt = readJSON(pycompat.JoinPath(directory, "attempt.json"))
	}
	request := readJSON(pycompat.JoinPath(requestDir, "request.json"))
	if request.isNone() {
		request = readJSON(pycompat.JoinPath(directory, "request.json"))
	}
	if workflow.isFalse() || attempt.isFalse() || request.isFalse() {
		return &pkg{shot: shotOf(directory), stage: "файлы пакета повреждены", unknown: true}, nil
	}
	if workflow.isNone() && attempt.isNone() && request.isNone() {
		return nil, nil
	}
	shot := shotOf(directory, workflow.dict(), request.dict())
	var stage any
	// Состояние исполнения принадлежит attempt.json и важнее этапа подготовки,
	// кроме ещё не отправленного запроса.
	attemptDoc, workflowDoc := attempt.dict(), workflow.dict()
	status := any(nil)
	if attemptDoc != nil {
		status = attemptDoc.Value("status")
	}
	if found, _ := pycompat.Contains([]any{nil, "prepared"}, status); attemptDoc != nil && !found {
		text, ok, err := label(attemptLabels, status)
		if err != nil {
			return nil, err
		}
		if !ok {
			text = "состояние попытки: " + pycompat.Str(status)
		}
		stage = text
	} else if workflowDoc != nil {
		raw := workflowDoc.Value("stage")
		text, ok, err := label(stageLabels, raw)
		if err != nil {
			return nil, err
		}
		switch {
		case ok:
			stage = text
		case pycompat.Truthy(raw):
			stage = "этап: " + pycompat.Str(raw)
		}
		if pycompat.Equal(raw, "keyframes_review") && pycompat.Truthy(workflowDoc.Value("current_keyframe")) {
			stage = "кадр " + pycompat.Str(workflowDoc.Value("current_keyframe")) + " на согласовании"
		}
		wait, ok, err := label(waitLabels, workflowDoc.Value("wait_reason"))
		if err != nil {
			return nil, err
		}
		if ok {
			stage = pycompat.Str(stage) + "; " + wait
		}
	} else if attemptDoc != nil {
		stage = attemptLabels["prepared"]
	}
	result := &pkg{shot: shot, unknown: stage == nil || shot == nil, stage: "этап не определён"}
	if text, ok := stage.(string); ok && text != "" {
		result.stage = text
	}
	return result, nil
}

// packages — словарь packages оригинала: пакеты по ключу плана в порядке первого появления.
type packages struct {
	order []string
	items map[string][]*pkg
}

// add — packages.setdefault(key, []).append(state).
func (p *packages) add(key string, state *pkg) {
	if _, ok := p.items[key]; !ok {
		p.order = append(p.order, key)
	}
	p.items[key] = append(p.items[key], state)
}

// packageKey — state["shot"] or folder.name.
func packageKey(state *pkg, folder string) string {
	if shot, ok := state.shot.(string); ok && shot != "" {
		return shot
	}
	return pycompat.PathName(folder)
}

// workPackages — work_packages(root): пакеты очереди и рабочих папок по планам и пробы
// review_pending (ключ — HashKey кода плана из рецепта).
func workPackages(root string) (*packages, map[string][]string, error) {
	result := &packages{items: map[string][]*pkg{}}
	reviews := map[string][]string{}
	relative := func(path string) string {
		text, _ := pycompat.RelativeTo(path, root)
		return text
	}
	awaiting := pycompat.Glob(pycompat.JoinPath(root, "plan", "awaiting"), "M*")
	pycompat.SortPaths(awaiting)
	for _, folder := range awaiting {
		if !pycompat.IsDir(folder) {
			continue
		}
		state, err := packageState(folder)
		if err != nil {
			return nil, nil, err
		}
		if state == nil {
			state = &pkg{shot: pycompat.PathName(folder), stage: "пакет очереди без файлов", unknown: true}
		}
		state.kind, state.path = "awaiting", relative(folder)
		result.add(packageKey(state, folder), state)
	}
	batches := pycompat.Glob(pycompat.JoinPath(root, "plan", "batches"), "*")
	pycompat.SortPaths(batches)
	for _, folder := range batches {
		if !pycompat.IsDir(folder) {
			continue
		}
		state, err := packageState(folder)
		if err != nil {
			return nil, nil, err
		}
		if state != nil {
			state.kind, state.path = "batch", relative(folder)
			result.add(packageKey(state, folder), state)
		}
		// folder.glob("*.json") без сортировки: порядок каталога, как у оригинала.
		for _, review := range pycompat.Glob(folder, "*.json") {
			recipe := readJSON(review).dict()
			if recipe == nil || !pycompat.Equal(recipe.Value("status"), "review_pending") {
				continue
			}
			shots, err := pycompat.DictGet(recipe, "shots", []any{})
			if err != nil {
				return nil, nil, err
			}
			items, err := pycompat.Iter(shots)
			if err != nil {
				return nil, nil, err
			}
			for _, item := range items {
				entry, ok := item.(*pycompat.Dict)
				if !ok || !pycompat.Truthy(entry.Value("id")) {
					continue
				}
				key, err := pycompat.HashKey(entry.Value("id"))
				if err != nil {
					return nil, nil, err
				}
				reviews[key] = append(reviews[key], relative(review))
			}
		}
	}
	return result, reviews, nil
}

// row — строка статуса плана в JSON и таблице.
type row struct {
	id, interval, duration any
	lipsync                bool
	status, stage          string
	notes                  []string
}

// result — collect(root): строки планов, очередь, кандидат next и пакеты вне реестра.
type result struct {
	rows       []row
	queue      []string
	next       any
	unassigned *pycompat.Dict
}

// staleStage — подпись устаревшего комплекта по коду причины единого правила приёмки.
func staleStage(reason any, source string) string {
	switch reason {
	case sceneregistry.SourceChanged:
		return "материал источника " + source + " изменён: нужно пересобрать и принять производный план"
	case sceneregistry.SourceUnavailable:
		return "источник " + source + " не готов или его выбранный клип повреждён: нужно восстановить источник и пересобрать производный план"
	case sceneregistry.SourceReceiptMissing:
		return "версия источника " + source + " неизвестна: нужно пересобрать и принять производный план"
	case sceneregistry.DerivedLinkChanged:
		return "связь с источником изменена: нужно новое производство плана"
	}
	return "постановка изменена после приёмки: нужно новое производство"
}

// get — dict.get для объекта, который должен быть словарём: иначе AttributeError Python.
func get(value any, key string) (any, error) {
	document, ok := value.(*pycompat.Dict)
	if !ok {
		return nil, pycompat.Raise(pycompat.AttributeError, "'%s' object has no attribute 'get'", pycompat.TypeName(value))
	}
	return document.Value(key), nil
}

// collect — collect(root) оригинала.
func collect(root string) (*result, error) {
	root = pycompat.ResolvePath(root)
	data, err := sceneregistry.Load(root)
	if err != nil {
		return nil, err
	}
	initial, err := sceneregistry.InitialStatesFor(root)
	if err != nil {
		return nil, err
	}
	items, err := sceneregistry.Shots(data, initial)
	if err != nil {
		return nil, err
	}
	work, reviews, err := workPackages(root)
	if err != nil {
		return nil, err
	}
	acceptance, err := sceneregistry.ProjectShotAcceptance(root, data)
	if err != nil {
		return nil, err
	}
	output := &result{queue: []string{}, unassigned: pycompat.NewDict()}
	ids := map[string]bool{}
	for _, scene := range items {
		sid := scene.Value("id").(string)
		ids[sid] = true
		own := work.items[sid]
		notes := []string{}
		for _, state := range own {
			notes = append(notes, state.kind+": "+state.path+" ("+state.stage+")")
		}
		for _, path := range reviews[mustHash(sid)] {
			notes = append(notes, "проба: "+path)
		}
		state, _ := acceptance.States.Get(sid)
		var status, stage string
		switch {
		case pycompat.Equal(state, sceneregistry.Completed):
			// Комплект принят по текущей постановке; незавершённая альтернатива не отменяет
			// готовность и показывается примечанием.
			status, stage = "completed", "выбранный комплект в assets"
		case pycompat.Equal(state, sceneregistry.Stale):
			// Код причины приходит из единого правила, а не вычисляется повторно по соседним статусам.
			derived := scene.Value("derived_from")
			if !pycompat.Truthy(derived) {
				derived = pycompat.NewDict()
			}
			source, err := get(derived, "shot")
			if err != nil {
				return nil, err
			}
			reason, _ := acceptance.Reasons.Get(sid)
			status, stage = "stale", staleStage(reason, pycompat.Str(source))
			if len(own) > 0 {
				stage += "; новая работа: " + own[0].stage
			}
		case anyUnknown(own):
			status, stage = "unknown", own[0].stage
		case len(own) > 0:
			status, stage = "progress", own[0].stage
		default:
			status, stage = "planned", "постановка в реестре, работа не начата"
		}
		output.rows = append(output.rows, row{
			id: sid, interval: scene.Value("interval"), duration: scene.Value("duration"),
			lipsync: pycompat.Truthy(scene.Value("lipsync")), status: status, stage: stage, notes: notes,
		})
	}
	for _, line := range output.rows {
		sid := line.id.(string)
		for _, state := range work.items[sid] {
			if state.kind == "awaiting" {
				output.queue = append(output.queue, sid)
				break
			}
		}
		if output.next == nil && line.status != "completed" {
			output.next = sid
		}
	}
	for _, key := range work.order {
		if ids[key] {
			continue
		}
		paths := []any{}
		for _, state := range work.items[key] {
			paths = append(paths, state.path)
		}
		output.unassigned.Set(key, paths)
	}
	return output, nil
}

// mustHash — HashKey строки (у строки он всегда есть).
func mustHash(text string) string {
	key, _ := pycompat.HashKey(text)
	return key
}

// anyUnknown — any(p["unknown"] for p in own).
func anyUnknown(own []*pkg) bool {
	for _, state := range own {
		if state.unknown {
			return true
		}
	}
	return false
}

// document — JSON результата collect, как dict оригинала.
func (r *result) document() *pycompat.Dict {
	shots := make([]any, len(r.rows))
	for index, line := range r.rows {
		shots[index] = pytool.Record(
			"id", line.id, "interval", line.interval, "duration", line.duration, "lipsync", line.lipsync,
			"status", line.status, "label", statusLabels[line.status], "stage", line.stage, "notes", pytool.Strings(line.notes),
		)
	}
	return pytool.Record("shots", shots, "queue", pytool.Strings(r.queue), "next", r.next, "unassigned_packages", r.unassigned)
}

// table — table(result, status_filter): таблица Markdown, сводка, очередь и кандидат next.
func (r *result) table(filter string) string {
	lines := []string{"| План | Окно | Статус | Этап | Примечания |", "| --- | --- | --- | --- | --- |"}
	for _, line := range r.rows {
		if filter != "all" && line.status != filter {
			continue
		}
		notes := strings.Join(line.notes, "; ")
		if notes == "" {
			notes = "—"
		}
		lines = append(lines, "| "+pycompat.Str(line.id)+" | "+pycompat.Str(line.interval)+" · "+pycompat.Str(line.duration)+" с | "+
			statusLabels[line.status]+" | "+line.stage+" | "+notes+" |")
	}
	summary := []string{}
	for _, status := range statusOrder {
		count := 0
		for _, line := range r.rows {
			if line.status == status {
				count++
			}
		}
		if count > 0 {
			summary = append(summary, statusLabels[status]+": "+pycompat.NewInt(int64(count)).String())
		}
	}
	lines = append(lines, "", "Всего "+pycompat.NewInt(int64(len(r.rows))).String()+"; "+strings.Join(summary, ", ")+".")
	if len(r.queue) > 0 {
		lines = append(lines, "Очередь plan/awaiting: "+strings.Join(r.queue, ", ")+".")
	}
	next := "нет, все планы готовы"
	if text, ok := r.next.(string); ok && text != "" {
		next = text
	}
	lines = append(lines, "Кандидат next: "+next+".")
	for _, key := range r.unassigned.Keys() {
		paths := []string{}
		for _, path := range r.unassigned.Value(key).([]any) {
			paths = append(paths, path.(string))
		}
		lines = append(lines, "Пакет без плана в реестре: "+key+" — "+strings.Join(paths, ", ")+".")
	}
	return strings.Join(lines, "\n")
}

// sceneIndex — словарь {id: scene} и порядок кодов реестра (ancestors, independence).
type sceneIndex struct {
	scenes map[string]*pycompat.Dict
	order  []any
}

// indexScenes — {s["id"]: s for s in data["scenes"]} и [s["id"] for s in data["scenes"]].
func indexScenes(data *pycompat.Dict) (*sceneIndex, error) {
	items, err := pycompat.Iter(data.Value("scenes"))
	if err != nil {
		return nil, err
	}
	index := &sceneIndex{scenes: map[string]*pycompat.Dict{}}
	for _, item := range items {
		scene := item.(*pycompat.Dict)
		key, err := pycompat.HashKey(scene.Value("id"))
		if err != nil {
			return nil, err
		}
		index.scenes[key] = scene
		index.order = append(index.order, scene.Value("id"))
	}
	return index, nil
}

// scene — scenes[sid]: KeyError для неизвестного кода, TypeError для нехешируемого.
func (s *sceneIndex) scene(sid any) (*pycompat.Dict, error) {
	key, err := pycompat.HashKey(sid)
	if err != nil {
		return nil, err
	}
	scene, ok := s.scenes[key]
	if !ok {
		return nil, pycompat.NewKeyError(sid)
	}
	return scene, nil
}

// position — order.index(sid).
func (s *sceneIndex) position(sid any) (int, error) {
	for index, item := range s.order {
		if pycompat.Equal(item, sid) {
			return index, nil
		}
	}
	return 0, pycompat.New(pycompat.ValueError, pycompat.Repr(sid)+" is not in list")
}

// ancestors — ancestors(data, sid): все планы, от которых наследуется состояние sid, включая
// повтор same.
func (s *sceneIndex) ancestors(sid any) ([]any, error) {
	result := []any{}
	current := sid
	for {
		scene, err := s.scene(current)
		if err != nil {
			return nil, err
		}
		position, err := s.position(current)
		if err != nil {
			return nil, err
		}
		var source any
		if position > 0 {
			source = s.order[position-1]
		}
		if value, ok := scene.Get("state_from"); ok {
			source = value
		}
		if reference, ok := source.(*pycompat.Dict); ok {
			source = reference.Value("scene")
		}
		if found, _ := pycompat.Contains(result, source); source == nil || found {
			return result, nil
		}
		result = append(result, source)
		current = source
	}
}

// hasChanges — has_changes(scene): изменения состояния до или после плана.
func hasChanges(scene *pycompat.Dict) (bool, error) {
	changes, err := pycompat.DictGet(scene, "state_changes", pycompat.NewDict())
	if err != nil {
		return false, err
	}
	for _, phase := range []string{"before", "after"} {
		value, err := get(changes, phase)
		if err != nil {
			return false, err
		}
		if pycompat.Truthy(value) {
			return true, nil
		}
	}
	return false, nil
}

// independence — independence(data, ids): более поздний план партии наследует изменения более
// раннего из той же партии.
func (s *sceneIndex) independence(ids []string) ([]any, error) {
	missing := []string{}
	for _, sid := range ids {
		if _, ok := s.scenes[mustHash(sid)]; !ok {
			missing = append(missing, sid)
		}
	}
	if len(missing) > 0 {
		return nil, pycompat.New(pycompat.ValueError, "Неизвестные планы: "+strings.Join(missing, ", "))
	}
	unique := map[string]bool{}
	for _, sid := range ids {
		unique[sid] = true
	}
	if len(unique) != len(ids) {
		return nil, pycompat.New(pycompat.ValueError, "План указан в партии дважды.")
	}
	conflicts := []any{}
	for _, later := range ids {
		chain, err := s.ancestors(later)
		if err != nil {
			return nil, err
		}
		for _, earlier := range ids {
			if earlier == later {
				continue
			}
			if found, _ := pycompat.Contains(chain, earlier); !found {
				continue
			}
			changed, err := hasChanges(s.scenes[mustHash(earlier)])
			if err != nil {
				return nil, err
			}
			if changed {
				conflicts = append(conflicts, pytool.Record("shot", later, "depends_on", earlier,
					"reason", later+" наследует состояние после изменений "+earlier))
			}
		}
	}
	return conflicts, nil
}

// adjacentPairs — adjacent_pairs(data, ids): соседи по шкале, стык которых сверяется только после
// получения обоих.
func (s *sceneIndex) adjacentPairs(ids []string) ([]any, error) {
	type position struct {
		index int
		sid   string
	}
	positions := []position{}
	for _, sid := range ids {
		index, err := s.position(sid)
		if err != nil {
			return nil, err
		}
		positions = append(positions, position{index, sid})
	}
	sort.SliceStable(positions, func(a, b int) bool {
		if positions[a].index != positions[b].index {
			return positions[a].index < positions[b].index
		}
		return positions[a].sid < positions[b].sid
	})
	pairs := []any{}
	for index := 0; index+1 < len(positions); index++ {
		first, second := positions[index], positions[index+1]
		if second.index == first.index+1 {
			pairs = append(pairs, pytool.Record("first", first.sid, "second", second.sid,
				"reason", first.sid+" и "+second.sid+" соседи по монтажной шкале: стык между ними проверяется только после получения обоих"))
		}
	}
	return pairs, nil
}

// expected — ожидаемый отказ main: ValueError, OSError, KeyError.
func expected(err error) bool {
	return pycompat.IsAny(err, pycompat.ValueError, pycompat.OSError, pycompat.KeyError)
}

// failure — завершение main по исключению: parser.exit(1, …) или трассировка.
func failure(printer *pytool.Printer, err error) pytool.Output {
	if expected(err) {
		return printer.Fail(err.Error())
	}
	return printer.Crash(err)
}

// printJSON — print(json.dumps(value, ensure_ascii=False, indent=2)).
func printJSON(printer *pytool.Printer, value any) error {
	text, err := pytool.JSON(value)
	if err != nil {
		return err
	}
	return printer.Print(text)
}

// runIndependent — ветка --independent.
func runIndependent(root string, ids []string, asJSON bool, printer *pytool.Printer) pytool.Output {
	data, err := sceneregistry.Load(root)
	if err != nil {
		return failure(printer, err)
	}
	index, err := indexScenes(data)
	if err != nil {
		return failure(printer, err)
	}
	conflicts, err := index.independence(ids)
	if err != nil {
		return failure(printer, err)
	}
	adjacent, err := index.adjacentPairs(ids)
	if err != nil {
		return failure(printer, err)
	}
	switch {
	case asJSON:
		if err := printJSON(printer, pytool.Record("shots", pytool.Strings(ids), "conflicts", conflicts, "adjacent", adjacent)); err != nil {
			return failure(printer, err)
		}
	case len(conflicts) > 0:
		reasons := []string{}
		for _, conflict := range conflicts {
			reasons = append(reasons, conflict.(*pycompat.Dict).Value("reason").(string))
		}
		return printer.Fail(strings.Join(reasons, "\n"))
	default:
		if err := printer.Print("Планы независимы по состоянию: " + strings.Join(ids, ", ") + "."); err != nil {
			return failure(printer, err)
		}
		for _, pair := range adjacent {
			if err := printer.Print("Предупреждение: " + pair.(*pycompat.Dict).Value("reason").(string) + "."); err != nil {
				return failure(printer, err)
			}
		}
	}
	return printer.Exit(0)
}

// Run — main() инструмента на разрешённом корне проекта.
func Run(root string, args []string) pytool.Output {
	parsed, exit := pytool.Args(Parser, args)
	if exit != nil {
		return *exit
	}
	printer := &pytool.Printer{}
	asJSON, next := parsed.Bools["--json"], parsed.Bools["--next"]
	if ids := parsed.Values["--independent"]; len(ids) > 0 {
		return runIndependent(root, ids, asJSON, printer)
	}
	output, err := collect(root)
	if err != nil {
		return failure(printer, err)
	}
	switch {
	case asJSON && next:
		err = printJSON(printer, pytool.Record("next", output.next, "queue", pytool.Strings(output.queue)))
	case asJSON:
		err = printJSON(printer, output.document())
	case next:
		candidate := "нет"
		if text, ok := output.next.(string); ok && text != "" {
			candidate = text
		}
		err = printer.Print("Кандидат next: " + candidate + ".")
		if err == nil && len(output.queue) > 0 {
			err = printer.Print("Очередь plan/awaiting: " + strings.Join(output.queue, ", ") + ".")
		}
	default:
		filter := "all"
		if values := parsed.Values["--filter"]; len(values) > 0 {
			filter = values[0]
		}
		err = printer.Print(output.table(filter))
	}
	if err != nil {
		// UnicodeEncodeError — подкласс ValueError: print внутри try оригинала.
		return failure(printer, err)
	}
	return printer.Exit(0)
}
