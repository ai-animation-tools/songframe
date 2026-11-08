// Package checkworkspace проверяет согласованность рабочего дерева проекта после приёмки:
// карточки и квитанция карточек, лишние пакеты plan/batches и plan/awaiting, пустые папки;
// готовые экспорты, пробы и материалы ручного монтажа не считаются остатками.
//
// Вывод (текст или JSON с --json) зафиксирован эталоном testdata/golden/check-workspace, код 1
// при несоответствиях или отказе. Пакет только читает файлы проекта.
package checkworkspace

import (
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"

	"songframe/internal/sceneregistry"
	"songframe/internal/toolcli"
	"songframe/internal/toolregex"
	"songframe/internal/toolrt"
)

// Parser — разбор аргументов check_workspace; Prog и описание видны в справке и ошибках разбора.
var Parser = toolrt.ArgParser{
	Prog:        "check_workspace",
	Description: "Проверяет согласованность рабочего дерева после приёмки: лишние пакеты, карточки, пустые папки; @link README.md",
	Flags:       []toolrt.Flag{{Name: "--json"}},
}

var (
	// shotName — код плана в начале имени папки (совпадение с начала строки).
	shotName = toolregex.MustCompile(`(M\d{2}(?:\.\d+)?)(?:[-_]|$)`, 0)
	// sha256Hex — SHA-256 строчными шестнадцатеричными цифрами, строка целиком.
	sha256Hex = regexp.MustCompile(`^[0-9a-f]{64}$`)
)

// packageDocuments — документы рабочего пакета.
var packageDocuments = []string{"workflow.json", "request.json", "request/request.json"}

// textNoScenes — отказ без реестра сцен.
const textNoScenes = "Сначала необходимо создать сценарий: отсутствует plan/scenes.json."

// readJSON — значение JSON-файла, nil для отсутствующего файла (или null),
// damaged для повреждённого.
func readJSON(path string) (value any, damaged bool) { return toolrt.ReadJSON(path) }

// nonempty — непустой обычный файл.
func nonempty(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular() && info.Size() > 0
}

// truthy — истинность значения JSON: null, false, ноль, пустые строка, список и словарь ложны.
func truthy(value any) bool { return toolrt.Truthy(value) }

// nonEmptyString — значение — непустая строка.
func nonEmptyString(value any) bool {
	text, ok := value.(string)
	return ok && text != ""
}

// positiveInt — целое больше нуля; bool считается целым (true — 1).
func positiveInt(value any) bool {
	if !toolrt.IsInt(value) {
		return false
	}
	less, _ := toolrt.Less(toolrt.NewInt(0), value)
	return less
}

// completedBundle — условие готового экспорта bundle.json.
func completedBundle(folder string, bundle *toolrt.Dict) bool {
	project, isDict := bundle.Value("project").(*toolrt.Dict)
	if !isDict || !toolrt.Equal(project.Value("schema_version"), toolrt.NewInt(1)) || !truthy(project.Value("name")) {
		return false
	}
	if !toolrt.Equal(bundle.Value("fps"), toolrt.NewInt(30)) || !nonEmptyString(bundle.Value("song")) {
		return false
	}
	if end := bundle.Value("song_end_s"); !toolrt.IsNumber(end) {
		return false
	} else if positive, _ := toolrt.Less(toolrt.NewInt(0), end); !positive {
		return false
	}
	if _, ok := bundle.Value("references").(*toolrt.Dict); !ok {
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
		row, ok := value.(*toolrt.Dict)
		if !ok || !nonEmptyString(row.Value("shot")) {
			return false
		}
		status := row.Value("status")
		if found, _ := toolrt.Contains([]any{"video", "card"}, status); !found {
			return false
		}
		if !positiveInt(row.Value("frames_30")) {
			return false
		}
		key := "card"
		if toolrt.Equal(status, "video") {
			key = "accepted_clip"
		}
		if !nonEmptyString(row.Value(key)) {
			return false
		}
	}
	for _, name := range []string{"shots.csv", "lyrics.csv", "timeline.edl", "timeline.fcpxml", "README.md"} {
		if !nonempty(toolrt.JoinPath(folder, name)) {
			return false
		}
	}
	return true
}

// completedReview — условие готовой пробы build_review: рецепт рядом с непустым MP4.
func completedReview(recipe string, document *toolrt.Dict) bool {
	if !toolrt.Equal(document.Value("schema_version"), toolrt.NewInt(1)) || !toolrt.Equal(document.Value("fps"), toolrt.NewInt(30)) ||
		!toolrt.Equal(document.Value("status"), "review_pending") {
		return false
	}
	if digest, ok := document.Value("video_sha256").(string); !ok || !sha256Hex.MatchString(digest) {
		return false
	}
	if !positiveInt(document.Value("total_frames")) {
		return false
	}
	audio, ok := document.Value("audio").(*toolrt.Dict)
	if !ok || !truthy(audio.Value("path")) {
		return false
	}
	rows, ok := document.Value("shots").([]any)
	if !ok || len(rows) == 0 {
		return false
	}
	for _, value := range rows {
		row, ok := value.(*toolrt.Dict)
		if !ok || !truthy(row.Value("id")) {
			return false
		}
		if found, _ := toolrt.Contains([]any{"video", "card"}, row.Value("kind")); !found {
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
	suffix := toolrt.PathSuffix(normalized)
	return toolrt.PathStem(normalized) == toolrt.PathStem(recipe) && strings.ToLower(suffix) == ".mp4" &&
		nonempty(toolrt.WithSuffix(recipe, suffix))
}

// completedOutput — папка folder — готовый экспорт или проба, а не рабочий пакет. Готовые отличаются от рабочих
// пакетов. Имя папки ничего не доказывает; рабочий пакет не становится готовым от bundle.json.
func completedOutput(folder string) bool {
	for _, name := range packageDocuments {
		if toolrt.Exists(toolrt.JoinPath(folder, name)) {
			return false
		}
	}
	if bundle, ok := first(readJSON(toolrt.JoinPath(folder, "bundle.json"))).(*toolrt.Dict); ok && completedBundle(folder, bundle) {
		return true
	}
	recipes := toolrt.Glob(folder, "*.json")
	toolrt.SortPaths(recipes)
	for _, recipe := range recipes {
		if document, ok := first(readJSON(recipe)).(*toolrt.Dict); ok && completedReview(recipe, document) {
			return true
		}
	}
	return false
}

// first — значение readJSON без признака повреждения (повреждённый файл — не словарь).
func first(value any, _ bool) any { return value }

// packageOwners — коды планов папки folder: поле shot пакета, список shots пробы или код в имени.
func packageOwners(folder string) (*toolrt.Set, error) {
	for _, name := range packageDocuments {
		if document, ok := first(readJSON(toolrt.JoinPath(folder, name))).(*toolrt.Dict); ok && truthy(document.Value("shot")) {
			owners := toolrt.NewSet()
			owners.Add(toolrt.Str(document.Value("shot")))
			return owners, nil
		}
	}
	owners := toolrt.NewSet()
	specs := toolrt.Glob(folder, "*.json")
	toolrt.SortPaths(specs)
	for _, spec := range specs {
		document, ok := first(readJSON(spec)).(*toolrt.Dict)
		if !ok {
			continue
		}
		shots, ok := document.Value("shots").([]any)
		if !ok {
			continue
		}
		for _, value := range shots {
			if entry, ok := value.(*toolrt.Dict); ok && truthy(entry.Value("id")) {
				owners.Add(toolrt.Str(entry.Value("id")))
			}
		}
	}
	if owners.Len() > 0 {
		return owners, nil
	}
	if match, ok := shotName.MatchString(toolrt.PathName(folder)); ok {
		code, _ := match.Group(1)
		owners.Add(code)
	}
	return owners, nil
}

// newAttempt — папка folder — новая попытка уже принятого плана, то есть штатная работа.
// Остаток приёмки — пакет на этапе accepted или пакет с запросом принятого комплекта.
func newAttempt(folder, root string) bool {
	workflow, ok := first(readJSON(toolrt.JoinPath(folder, "workflow.json"))).(*toolrt.Dict)
	if !ok || !truthy(workflow.Value("stage")) || toolrt.Equal(workflow.Value("stage"), "accepted") {
		return false
	}
	var acceptedSHA any
	snapshotPath := toolrt.JoinPath(root, "assets", "shots", toolrt.Str(workflow.Value("shot")), "generation-request.json")
	if snapshot, ok := first(readJSON(snapshotPath)).(*toolrt.Dict); ok {
		acceptedSHA = snapshot.Value("request_sha256")
	}
	var attemptSHA any
	if directory, ok := workflow.Value("request_dir").(string); ok && directory != "" {
		if attempt, ok := first(readJSON(toolrt.JoinPath(folder, directory, "attempt.json"))).(*toolrt.Dict); ok {
			attemptSHA = attempt.Value("request_sha256")
		}
	}
	return !(truthy(acceptedSHA) && toolrt.Equal(attemptSHA, acceptedSHA))
}

// retainedMontageFolders — рабочие папки, нужные черновикам и экспортам ручного монтажа.
// Повреждённый черновик удерживает все папки plan/batches и plan/awaiting: неизвестные
// зависимости нельзя очистить.
func retainedMontageFolders(root string) map[string]bool {
	root = toolrt.ResolvePath(root)
	retained := map[string]bool{}
	drafts := toolrt.Glob(toolrt.JoinPath(root, "plan", "montage"), "*.json")
	// montage.json — сохранённый рецепт ручного экспорта или применения, а не разовая проба агента.
	for _, marker := range toolrt.Glob(toolrt.JoinPath(root, "plan", "batches"), "*/montage.json") {
		retained[toolrt.ResolvePath(filepath.Dir(marker))] = true
		drafts = append(drafts, marker)
	}
	for _, path := range drafts {
		if err := draftFolders(root, path, retained); err != nil {
			for _, base := range []string{"batches", "awaiting"} {
				for _, folder := range toolrt.Glob(toolrt.JoinPath(root, "plan", base), "*") {
					if toolrt.IsDir(folder) {
						retained[toolrt.ResolvePath(folder)] = true
					}
				}
			}
		}
	}
	return retained
}

// draftFolders — папки одного черновика монтажа для retainedMontageFolders. Ошибка — любой отказ
// чтения или разбора черновика (OSError, ValueError, KeyError, TypeError, AttributeError): тогда
// черновик считается повреждённым.
func draftFolders(root, path string, retained map[string]bool) error {
	value, err := toolrt.LoadJSONFile(path)
	if err != nil {
		return err
	}
	clipsValue, err := toolrt.DictGet(value, "clips", []any{})
	if err != nil {
		return err
	}
	clips, err := toolrt.Iter(clipsValue)
	if err != nil {
		return err
	}
	for _, clip := range clips {
		location, err := toolrt.Item(clip, "path")
		if err != nil {
			return err
		}
		name, ok := location.(string)
		if !ok {
			return toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(location))
		}
		source := toolrt.ResolvePath(toolrt.JoinPath(root, name))
		relative, err := toolrt.RelativeTo(source, root)
		if err != nil {
			return err
		}
		parts := strings.FieldsFunc(relative, func(r rune) bool { return r == '/' || r == filepath.Separator })
		if relative == "." {
			parts = nil
		}
		if len(parts) >= 4 && parts[0] == "plan" && (parts[1] == "batches" || parts[1] == "awaiting") {
			retained[toolrt.JoinPath(root, parts[0], parts[1], parts[2])] = true
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

// sortShots — коды Mxx по возрастанию числа после «M» (устойчиво для равных чисел).
func sortShots(ids []string) []string {
	result := append([]string(nil), ids...)
	number := func(sid string) float64 {
		value, _ := toolrt.FloatFromString(string([]rune(sid)[1:]))
		return value
	}
	sort.SliceStable(result, func(a, b int) bool { return number(result[a]) < number(result[b]) })
	return result
}

// Collect — список несоответствий проекта root; пустой означает, что приёмка и обновление
// представлений отработали штатно.
func Collect(root string) (Result, error) {
	root = toolrt.ResolvePath(root)
	scenes, err := sceneregistry.Load(root)
	if toolrt.Is(err, toolrt.FileNotFoundError) {
		// Без сценария проверка ещё невозможна; пустой реестр скрыл бы этот этап.
		return Result{}, toolrt.New(toolrt.ValueError, textNoScenes)
	}
	if err != nil {
		return Result{}, err
	}
	ids := []string{}
	idSet := toolrt.NewSet()
	items, _ := toolrt.Iter(scenes.Value("scenes"))
	for _, item := range items {
		id := item.(*toolrt.Dict).Value("id").(string)
		ids = append(ids, id)
		idSet.Add(id)
	}
	// Порядок в папке зависит от наличия комплекта: устаревший по постановке комплект по-прежнему
	// заменяет карточку в сборке. Актуальность принятия выводится отдельно.
	accepted := toolrt.NewSet()
	acceptedOrder := []string{}
	for _, sid := range ids {
		if toolrt.IsFile(toolrt.JoinPath(root, "assets", "shots", sid, "manifest.json")) && !accepted.Contains(sid) {
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
		text, _ := toolrt.RelativeTo(path, root)
		return text
	}

	cards := toolrt.JoinPath(root, "plan", "animatic", "cards")
	if toolrt.IsDir(cards) {
		pngs := toolrt.Glob(cards, "*.png")
		toolrt.SortPaths(pngs)
		for _, png := range pngs {
			sid, _, _ := strings.Cut(toolrt.PathName(png), ".")
			if accepted.Contains(sid) {
				add("card_of_accepted", relative(png), "карточка принятого плана "+sid+"; обновите представления")
			} else if !idSet.Contains(sid) {
				add("card_unknown", relative(png), "карточка плана, которого нет в реестре")
			}
		}
	}
	for _, sid := range ids {
		if !accepted.Contains(sid) && !toolrt.IsFile(toolrt.JoinPath(cards, sid+".png")) {
			add("card_missing", "plan/animatic/cards/"+sid+".png", "нет карточки незавершённого плана "+sid+"; обновите представления")
		}
	}
	listed := toolrt.NewSet()
	if receipt, ok := first(readJSON(toolrt.JoinPath(cards, "manifest.json"))).(*toolrt.Dict); ok {
		value, _ := toolrt.DictGet(receipt, "cards", toolrt.NewDict())
		if listed, err = toolrt.SetOf(value); err != nil {
			return Result{}, err
		}
	}
	expected := toolrt.NewSet()
	for _, sid := range ids {
		if !accepted.Contains(sid) {
			expected.Add(sid)
		}
	}
	if !listed.Equal(expected) {
		add("receipt_stale", "plan/animatic/cards/manifest.json", "квитанция карточек не совпадает с незавершёнными планами; обновите представления")
	}

	batches := toolrt.JoinPath(root, "plan", "batches")
	retained := retainedMontageFolders(root)
	if toolrt.IsDir(batches) {
		folders, err := toolrt.IterDir(batches)
		if err != nil {
			return Result{}, err
		}
		toolrt.SortPaths(folders)
		for _, folder := range folders {
			if !toolrt.IsDir(folder) || retained[toolrt.ResolvePath(folder)] {
				continue
			}
			entries, err := toolrt.IterDir(folder)
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

	awaiting := toolrt.JoinPath(root, "plan", "awaiting")
	if toolrt.IsDir(awaiting) {
		folders := toolrt.Glob(awaiting, "M*")
		toolrt.SortPaths(folders)
		for _, folder := range folders {
			name := toolrt.PathName(folder)
			if toolrt.IsDir(folder) && accepted.Contains(name) && !retained[toolrt.ResolvePath(folder)] && !newAttempt(folder, root) {
				add("queue_of_accepted", relative(folder), "пакет очереди принятого плана "+name+"; приёмка без --clean")
			}
		}
	}
	result := Result{Accepted: []string{}, Stale: []string{}, Problems: problems}
	for _, sid := range acceptedOrder {
		state, found := acceptance.States.Get(sid)
		if !found {
			return Result{}, toolrt.NewKeyError(sid)
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

// sortedStrings — элементы множества строк по возрастанию.
func sortedStrings(set *toolrt.Set) []string {
	result := []string{}
	for _, item := range set.Items() {
		result = append(result, item.(string))
	}
	sort.Strings(result)
	return result
}

// document — JSON результата collect.
func (r Result) document() *toolrt.Dict {
	problems := make([]any, len(r.Problems))
	for index, problem := range r.Problems {
		problems[index] = toolcli.Record("kind", problem.Kind, "path", problem.Path, "message", problem.Message)
	}
	return toolcli.Record("accepted", toolcli.Strings(r.Accepted), "stale", toolcli.Strings(r.Stale), "problems", problems)
}

// Run — инструмент check_workspace на разрешённом корне проекта.
func Run(root string, args []string) toolcli.Output {
	parsed, exit := toolcli.Args(Parser, args)
	if exit != nil {
		return *exit
	}
	asJSON := parsed.Bools["--json"]
	printer := &toolcli.Printer{}
	result, err := Collect(root)
	if err != nil {
		if !toolrt.IsAny(err, toolrt.ValueError, toolrt.OSError, toolrt.KeyError) {
			return printer.Crash(err)
		}
		if asJSON {
			text, dumpErr := toolcli.JSON(toolcli.Record("error", err.Error()))
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
		text, err := toolcli.JSON(result.document())
		if err != nil {
			return printer.Crash(err)
		}
		lines = append(lines, text)
	} else {
		lines = append(lines, "Принятых планов: "+toolrt.NewInt(int64(len(result.Accepted))).String()+".")
		if len(result.Stale) > 0 {
			lines = append(lines, "Постановка изменена после приёмки, нужно новое производство: "+strings.Join(result.Stale, ", ")+".")
		}
		for _, problem := range result.Problems {
			lines = append(lines, "- "+problem.Path+": "+problem.Message)
		}
		if len(result.Problems) == 0 {
			lines = append(lines, "Рабочее дерево согласовано.")
		} else {
			lines = append(lines, "Несоответствий: "+toolrt.NewInt(int64(len(result.Problems))).String()+".")
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

// PackageOwners — packageOwners для очистки после приёмки (accept_shot): коды планов,
// которым принадлежит рабочая папка.
func PackageOwners(folder string) (*toolrt.Set, error) { return packageOwners(folder) }

// RetainedMontageFolders — retainedMontageFolders для очистки после приёмки: реальные
// пути папок, которые удерживают черновики и экспорты ручного монтажа.
func RetainedMontageFolders(root string) map[string]bool { return retainedMontageFolders(root) }
