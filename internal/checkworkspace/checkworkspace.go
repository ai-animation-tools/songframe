// Package checkworkspace — перенос tools/check_workspace/check_workspace.py замороженного
// оригинала (вместе с tools/montage_files.py): согласованность рабочего дерева проекта после
// приёмки — карточки и квитанция карточек, лишние пакеты plan/batches и plan/awaiting, пустые
// папки; готовые экспорты, пробы и материалы ручного монтажа не считаются остатками.
//
// Вывод совпадает с CLI оригинала (текст или JSON с --json), код 1 при несоответствиях или
// отказе. Пакет только читает файлы проекта.
package checkworkspace

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/pyre"
	"songframe-go/internal/pytool"
	"songframe-go/internal/sceneregistry"
)

// Parser — argparse оригинала (описание — docstring модуля).
var Parser = pycompat.ArgParser{
	Prog:        "check_workspace.py",
	Description: "Проверяет согласованность рабочего дерева после приёмки: лишние пакеты, карточки, пустые папки; @link README.md",
	Flags:       []pycompat.Flag{{Name: "--json"}},
}

var (
	// shotName — SHOT_NAME.match: код плана в начале имени папки.
	shotName = pyre.MustCompile(`(M\d{2}(?:\.\d+)?)(?:[-_]|$)`, 0)
	// sha256Hex — re.fullmatch(r"[0-9a-f]{64}").
	sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// packageDocuments — PACKAGE_DOCUMENTS: документы рабочего пакета.
var packageDocuments = []string{"workflow.json", "request.json", "request/request.json"}

// textNoScenes — отказ без реестра сцен.
const textNoScenes = "Сначала необходимо создать сценарий: отсутствует plan/scenes.json."

// readJSON — tools/common.py read_json: значение, nil для отсутствующего файла (или null),
// damaged для повреждённого.
func readJSON(path string) (value any, damaged bool) { return pycompat.ReadJSON(path) }

// nonempty — непустой обычный файл.
func nonempty(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

// truthy — bool(value) Python.
func truthy(value any) bool { return pycompat.Truthy(value) }

// isString — isinstance(value, str) и непустая строка, если nonEmpty.
func nonEmptyString(value any) bool {
	text, ok := value.(string)
	return ok && text != ""
}

// positiveInt — isinstance(value, int) and value > 0 (bool — подкласс int).
func positiveInt(value any) bool {
	if !pycompat.IsInt(value) {
		return false
	}
	less, _ := pycompat.Less(pycompat.NewInt(0), value)
	return less
}

// completedBundle — условие готового экспорта bundle.json.
func completedBundle(folder string, bundle *pycompat.Dict) bool {
	project, isDict := bundle.Value("project").(*pycompat.Dict)
	if !isDict || !pycompat.Equal(project.Value("schema_version"), pycompat.NewInt(1)) || !truthy(project.Value("name")) {
		return false
	}
	if !pycompat.Equal(bundle.Value("fps"), pycompat.NewInt(30)) || !nonEmptyString(bundle.Value("song")) {
		return false
	}
	if end := bundle.Value("song_end_s"); !pycompat.IsNumber(end) {
		return false
	} else if positive, _ := pycompat.Less(pycompat.NewInt(0), end); !positive {
		return false
	}
	if _, ok := bundle.Value("references").(*pycompat.Dict); !ok {
		return false
	}
	if _, ok := bundle.Value("lyrics").([]any); !ok {
		return false
	}
	rows, ok := bundle.Value("shots").([]any)
	if !ok || len(rows) == 0 {
		return false
	}
	for _, value := range rows {
		row, ok := value.(*pycompat.Dict)
		if !ok || !nonEmptyString(row.Value("shot")) {
			return false
		}
		status := row.Value("status")
		if found, _ := pycompat.Contains([]any{"video", "card"}, status); !found {
			return false
		}
		if !positiveInt(row.Value("frames_30")) {
			return false
		}
		key := "card"
		if pycompat.Equal(status, "video") {
			key = "accepted_clip"
		}
		if !nonEmptyString(row.Value(key)) {
			return false
		}
	}
	for _, name := range []string{"shots.csv", "lyrics.csv", "timeline.edl", "timeline.fcpxml", "README.md"} {
		if !nonempty(pycompat.JoinPath(folder, name)) {
			return false
		}
	}
	return true
}

// completedReview — условие готовой пробы build_review: рецепт рядом с непустым MP4.
func completedReview(recipe string, document *pycompat.Dict) bool {
	if !pycompat.Equal(document.Value("schema_version"), pycompat.NewInt(1)) || !pycompat.Equal(document.Value("fps"), pycompat.NewInt(30)) ||
		!pycompat.Equal(document.Value("status"), "review_pending") {
		return false
	}
	if digest, ok := document.Value("video_sha256").(string); !ok || !sha256Hex.MatchString(digest) {
		return false
	}
	if !positiveInt(document.Value("total_frames")) {
		return false
	}
	audio, ok := document.Value("audio").(*pycompat.Dict)
	if !ok || !truthy(audio.Value("path")) {
		return false
	}
	rows, ok := document.Value("shots").([]any)
	if !ok || len(rows) == 0 {
		return false
	}
	for _, value := range rows {
		row, ok := value.(*pycompat.Dict)
		if !ok || !truthy(row.Value("id")) {
			return false
		}
		if found, _ := pycompat.Contains([]any{"video", "card"}, row.Value("kind")); !found {
			return false
		}
		if !truthy(row.Value("path")) || !truthy(row.Value("sha256")) || !positiveInt(row.Value("frames")) {
			return false
		}
	}
	output, ok := document.Value("output").(string)
	if !ok || output == "" {
		return false
	}
	// Сам MP4 ищем рядом с рецептом: сохранённый абсолютный output устаревает при переносе проекта.
	normalized := strings.ReplaceAll(output, `\`, "/")
	suffix := pycompat.PathSuffix(normalized)
	return pycompat.PathStem(normalized) == pycompat.PathStem(recipe) && strings.ToLower(suffix) == ".mp4" &&
		nonempty(pycompat.WithSuffix(recipe, suffix))
}

// completedOutput — completed_output(folder): готовые экспорт и проба отличаются от рабочих
// пакетов. Имя папки ничего не доказывает; рабочий пакет не становится готовым от bundle.json.
func completedOutput(folder string) bool {
	for _, name := range packageDocuments {
		if pycompat.Exists(pycompat.JoinPath(folder, name)) {
			return false
		}
	}
	if bundle, ok := first(readJSON(pycompat.JoinPath(folder, "bundle.json"))).(*pycompat.Dict); ok && completedBundle(folder, bundle) {
		return true
	}
	recipes := pycompat.Glob(folder, "*.json")
	pycompat.SortPaths(recipes)
	for _, recipe := range recipes {
		if document, ok := first(readJSON(recipe)).(*pycompat.Dict); ok && completedReview(recipe, document) {
			return true
		}
	}
	return false
}

// first — значение read_json без признака повреждения (повреждённый файл — не словарь).
func first(value any, _ bool) any { return value }

// packageOwners — package_owners(folder): поле shot пакета, список shots пробы или код в имени.
func packageOwners(folder string) (*pycompat.Set, error) {
	for _, name := range packageDocuments {
		if document, ok := first(readJSON(pycompat.JoinPath(folder, name))).(*pycompat.Dict); ok && truthy(document.Value("shot")) {
			owners := pycompat.NewSet()
			owners.Add(pycompat.Str(document.Value("shot")))
			return owners, nil
		}
	}
	owners := pycompat.NewSet()
	specs := pycompat.Glob(folder, "*.json")
	pycompat.SortPaths(specs)
	for _, spec := range specs {
		document, ok := first(readJSON(spec)).(*pycompat.Dict)
		if !ok {
			continue
		}
		shots, ok := document.Value("shots").([]any)
		if !ok {
			continue
		}
		for _, value := range shots {
			if entry, ok := value.(*pycompat.Dict); ok && truthy(entry.Value("id")) {
				owners.Add(pycompat.Str(entry.Value("id")))
			}
		}
	}
	if owners.Len() > 0 {
		return owners, nil
	}
	if match, ok := shotName.MatchString(pycompat.PathName(folder)); ok {
		code, _ := match.Group(1)
		owners.Add(code)
	}
	return owners, nil
}

// newAttempt — new_attempt(folder, root): новая попытка уже принятого плана — штатная работа.
// Остаток приёмки — пакет на этапе accepted или пакет с запросом принятого комплекта.
func newAttempt(folder, root string) bool {
	workflow, ok := first(readJSON(pycompat.JoinPath(folder, "workflow.json"))).(*pycompat.Dict)
	if !ok || !truthy(workflow.Value("stage")) || pycompat.Equal(workflow.Value("stage"), "accepted") {
		return false
	}
	var acceptedSHA any
	snapshotPath := pycompat.JoinPath(root, "assets", "shots", pycompat.Str(workflow.Value("shot")), "generation-request.json")
	if snapshot, ok := first(readJSON(snapshotPath)).(*pycompat.Dict); ok {
		acceptedSHA = snapshot.Value("request_sha256")
	}
	var attemptSHA any
	if directory, ok := workflow.Value("request_dir").(string); ok && directory != "" {
		if attempt, ok := first(readJSON(pycompat.JoinPath(folder, directory, "attempt.json"))).(*pycompat.Dict); ok {
			attemptSHA = attempt.Value("request_sha256")
		}
	}
	return !(truthy(acceptedSHA) && pycompat.Equal(attemptSHA, acceptedSHA))
}

// retainedMontageFolders — retained_montage_folders(root) из tools/montage_files.py: рабочие
// папки, нужные черновикам и экспортам ручного монтажа. Повреждённый черновик удерживает все
// папки plan/batches и plan/awaiting: неизвестные зависимости нельзя очистить.
func retainedMontageFolders(root string) map[string]bool {
	root = pycompat.ResolvePath(root)
	retained := map[string]bool{}
	drafts := pycompat.Glob(pycompat.JoinPath(root, "plan", "montage"), "*.json")
	// montage.json — сохранённый рецепт ручного экспорта или применения, а не разовая проба агента.
	for _, marker := range pycompat.Glob(pycompat.JoinPath(root, "plan", "batches"), "*/montage.json") {
		retained[pycompat.ResolvePath(filepath.Dir(marker))] = true
		drafts = append(drafts, marker)
	}
	for _, path := range drafts {
		if err := draftFolders(root, path, retained); err != nil {
			for _, base := range []string{"batches", "awaiting"} {
				for _, folder := range pycompat.Glob(pycompat.JoinPath(root, "plan", base), "*") {
					if pycompat.IsDir(folder) {
						retained[pycompat.ResolvePath(folder)] = true
					}
				}
			}
		}
	}
	return retained
}

// draftFolders — тело try в retained_montage_folders для одного черновика: ошибка — любое из
// перехватываемых исключений (OSError, ValueError, KeyError, TypeError, AttributeError).
func draftFolders(root, path string, retained map[string]bool) error {
	value, err := pycompat.LoadJSONFile(path)
	if err != nil {
		return err
	}
	clipsValue, err := pycompat.DictGet(value, "clips", []any{})
	if err != nil {
		return err
	}
	clips, err := pycompat.Iter(clipsValue)
	if err != nil {
		return err
	}
	for _, clip := range clips {
		location, err := pycompat.Item(clip, "path")
		if err != nil {
			return err
		}
		name, ok := location.(string)
		if !ok {
			return pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: 'PosixPath' and '%s'", pycompat.TypeName(location))
		}
		source := pycompat.ResolvePath(pycompat.JoinPath(root, name))
		relative, err := pycompat.RelativeTo(source, root)
		if err != nil {
			return err
		}
		parts := strings.FieldsFunc(relative, func(r rune) bool { return r == '/' || r == filepath.Separator })
		if relative == "." {
			parts = nil
		}
		if len(parts) >= 4 && parts[0] == "plan" && (parts[1] == "batches" || parts[1] == "awaiting") {
			retained[pycompat.JoinPath(root, parts[0], parts[1], parts[2])] = true
		}
	}
	return nil
}

// Problem — несоответствие рабочего дерева: вид, путь от корня проекта и текст.
type Problem struct{ Kind, Path, Message string }

// Result — итог collect: принятые по текущей постановке, устаревшие и несоответствия.
type Result struct {
	Accepted, Stale []string
	Problems        []Problem
}

// sortShots — sorted(…, key=number): коды Mxx по числу после «M».
func sortShots(ids []string) []string {
	result := append([]string(nil), ids...)
	number := func(sid string) float64 {
		value, _ := pycompat.FloatFromString(string([]rune(sid)[1:]))
		return value
	}
	sort.SliceStable(result, func(a, b int) bool { return number(result[a]) < number(result[b]) })
	return result
}

// Collect — collect(root): список несоответствий; пустой означает, что приёмка и обновление
// представлений отработали штатно.
func Collect(root string) (Result, error) {
	root = pycompat.ResolvePath(root)
	scenes, err := sceneregistry.Load(root)
	if pycompat.Is(err, pycompat.FileNotFoundError) {
		// Без сценария проверка ещё невозможна; пустой реестр скрыл бы этот этап.
		return Result{}, pycompat.New(pycompat.ValueError, textNoScenes)
	}
	if err != nil {
		return Result{}, err
	}
	ids := []string{}
	idSet := pycompat.NewSet()
	items, _ := pycompat.Iter(scenes.Value("scenes"))
	for _, item := range items {
		id := item.(*pycompat.Dict).Value("id").(string)
		ids = append(ids, id)
		idSet.Add(id)
	}
	// Порядок в папке зависит от наличия комплекта: устаревший по постановке комплект по-прежнему
	// заменяет карточку в сборке. Актуальность принятия выводится отдельно.
	accepted := pycompat.NewSet()
	acceptedOrder := []string{}
	for _, sid := range ids {
		if pycompat.IsFile(pycompat.JoinPath(root, "assets", "shots", sid, "manifest.json")) && !accepted.Contains(sid) {
			accepted.Add(sid)
			acceptedOrder = append(acceptedOrder, sid)
		}
	}
	acceptance, err := sceneregistry.ProjectShotAcceptance(root, scenes)
	if err != nil {
		return Result{}, err
	}
	problems := []Problem{}
	add := func(kind, path, message string) { problems = append(problems, Problem{kind, path, message}) }
	relative := func(path string) string {
		text, _ := pycompat.RelativeTo(path, root)
		return text
	}

	cards := pycompat.JoinPath(root, "plan", "animatic", "cards")
	if pycompat.IsDir(cards) {
		pngs := pycompat.Glob(cards, "*.png")
		pycompat.SortPaths(pngs)
		for _, png := range pngs {
			sid, _, _ := strings.Cut(pycompat.PathName(png), ".")
			if accepted.Contains(sid) {
				add("card_of_accepted", relative(png), "карточка принятого плана "+sid+"; обновите представления")
			} else if !idSet.Contains(sid) {
				add("card_unknown", relative(png), "карточка плана, которого нет в реестре")
			}
		}
	}
	for _, sid := range ids {
		if !accepted.Contains(sid) && !pycompat.IsFile(pycompat.JoinPath(cards, sid+".png")) {
			add("card_missing", "plan/animatic/cards/"+sid+".png", "нет карточки незавершённого плана "+sid+"; обновите представления")
		}
	}
	listed := pycompat.NewSet()
	if receipt, ok := first(readJSON(pycompat.JoinPath(cards, "manifest.json"))).(*pycompat.Dict); ok {
		value, _ := pycompat.DictGet(receipt, "cards", pycompat.NewDict())
		if listed, err = pycompat.SetOf(value); err != nil {
			return Result{}, err
		}
	}
	expected := pycompat.NewSet()
	for _, sid := range ids {
		if !accepted.Contains(sid) {
			expected.Add(sid)
		}
	}
	if !listed.Equal(expected) {
		add("receipt_stale", "plan/animatic/cards/manifest.json", "квитанция карточек не совпадает с незавершёнными планами; обновите представления")
	}

	batches := pycompat.JoinPath(root, "plan", "batches")
	retained := retainedMontageFolders(root)
	if pycompat.IsDir(batches) {
		folders, err := pycompat.IterDir(batches)
		if err != nil {
			return Result{}, err
		}
		pycompat.SortPaths(folders)
		for _, folder := range folders {
			if !pycompat.IsDir(folder) || retained[pycompat.ResolvePath(folder)] {
				continue
			}
			entries, err := pycompat.IterDir(folder)
			if err != nil {
				return Result{}, err
			}
			if len(entries) == 0 {
				add("empty_folder", relative(folder), "пустая папка пробы или пакета")
				continue
			}
			if completedOutput(folder) {
				continue
			}
			owners, err := packageOwners(folder)
			if err != nil {
				return Result{}, err
			}
			unknown := owners.Minus(idSet)
			switch {
			case owners.Len() == 0:
				add("package_unowned", relative(folder), "папка без плана-владельца; проверьте вручную")
			case unknown.Len() > 0:
				add("package_unknown", relative(folder), "пакет планов, которых нет в реестре: "+strings.Join(sortedStrings(unknown), ", "))
			case owners.SubsetOf(accepted) && !newAttempt(folder, root):
				// Проба нескольких планов нужна, пока хотя бы один из них не принят.
				add("package_of_accepted", relative(folder), "рабочий пакет принятых планов "+strings.Join(sortedStrings(owners), ", ")+"; приёмка без --clean")
			}
		}
	}

	awaiting := pycompat.JoinPath(root, "plan", "awaiting")
	if pycompat.IsDir(awaiting) {
		folders := pycompat.Glob(awaiting, "M*")
		pycompat.SortPaths(folders)
		for _, folder := range folders {
			name := pycompat.PathName(folder)
			if pycompat.IsDir(folder) && accepted.Contains(name) && !retained[pycompat.ResolvePath(folder)] && !newAttempt(folder, root) {
				add("queue_of_accepted", relative(folder), "пакет очереди принятого плана "+name+"; приёмка без --clean")
			}
		}
	}
	result := Result{Accepted: []string{}, Stale: []string{}, Problems: problems}
	for _, sid := range acceptedOrder {
		state, found := acceptance.States.Get(sid)
		if !found {
			return Result{}, pycompat.NewKeyError(sid)
		}
		switch state {
		case sceneregistry.Completed:
			result.Accepted = append(result.Accepted, sid)
		case sceneregistry.Stale:
			result.Stale = append(result.Stale, sid)
		}
	}
	result.Accepted, result.Stale = sortShots(result.Accepted), sortShots(result.Stale)
	return result, nil
}

// sortedStrings — sorted(set) строк.
func sortedStrings(set *pycompat.Set) []string {
	result := []string{}
	for _, item := range set.Items() {
		result = append(result, item.(string))
	}
	sort.Strings(result)
	return result
}

// document — JSON результата collect.
func (r Result) document() *pycompat.Dict {
	problems := make([]any, len(r.Problems))
	for index, problem := range r.Problems {
		problems[index] = pytool.Record("kind", problem.Kind, "path", problem.Path, "message", problem.Message)
	}
	return pytool.Record("accepted", pytool.Strings(r.Accepted), "stale", pytool.Strings(r.Stale), "problems", problems)
}

// Run — main() инструмента на разрешённом корне проекта.
func Run(root string, args []string) pytool.Output {
	parsed, exit := pytool.Args(Parser, args)
	if exit != nil {
		return *exit
	}
	asJSON := parsed.Bools["--json"]
	printer := &pytool.Printer{}
	result, err := Collect(root)
	if err != nil {
		if !pycompat.IsAny(err, pycompat.ValueError, pycompat.OSError, pycompat.KeyError) {
			return printer.Crash(err)
		}
		if asJSON {
			text, dumpErr := pytool.JSON(pytool.Record("error", err.Error()))
			if dumpErr == nil {
				dumpErr = printer.Print(text)
			}
			if dumpErr != nil {
				return printer.Crash(dumpErr)
			}
			return printer.Exit(1)
		}
		return printer.Fail(err.Error())
	}
	lines := []string{}
	if asJSON {
		text, err := pytool.JSON(result.document())
		if err != nil {
			return printer.Crash(err)
		}
		lines = append(lines, text)
	} else {
		lines = append(lines, "Принятых планов: "+pycompat.NewInt(int64(len(result.Accepted))).String()+".")
		if len(result.Stale) > 0 {
			lines = append(lines, "Постановка изменена после приёмки, нужно новое производство: "+strings.Join(result.Stale, ", ")+".")
		}
		for _, problem := range result.Problems {
			lines = append(lines, "- "+problem.Path+": "+problem.Message)
		}
		if len(result.Problems) == 0 {
			lines = append(lines, "Рабочее дерево согласовано.")
		} else {
			lines = append(lines, "Несоответствий: "+pycompat.NewInt(int64(len(result.Problems))).String()+".")
		}
	}
	for _, line := range lines {
		if err := printer.Print(line); err != nil {
			return printer.Crash(err)
		}
	}
	if len(result.Problems) > 0 {
		return printer.Exit(1)
	}
	return printer.Exit(0)
}

// PackageOwners — package_owners(folder) для очистки после приёмки (accept_shot): коды планов,
// которым принадлежит рабочая папка.
func PackageOwners(folder string) (*pycompat.Set, error) { return packageOwners(folder) }

// RetainedMontageFolders — retained_montage_folders(root) для очистки после приёмки: реальные
// пути папок, которые удерживают черновики и экспорты ручного монтажа.
func RetainedMontageFolders(root string) map[string]bool { return retainedMontageFolders(root) }
