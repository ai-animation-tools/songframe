package tools_test

import (
	"bytes"
	"image/png"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/projectviews"
	"songframe/internal/toolrt"
	"songframe/internal/tools"
)

// checkStreams — сверка кода завершения и потоков результата tools.Run с эталоном
// (`<project>` вместо пути копии; у трассировки — заголовок и последняя строка). compare
// подменяет сравнение stdout/stderr, если оно не побайтное (список карточек scene-views).
func checkStreams(t *testing.T, expected *toolrt.Dict, result tools.Result, root string, compare func(want, got string) bool) {
	t.Helper()
	normalize := func(text string) string { return strings.ReplaceAll(text, root, golden.ProjectMarker) }
	if want := expected.Value("code").(toolrt.Int).String(); result.Code == nil || want != toolrt.NewInt(int64(*result.Code)).String() {
		t.Errorf("код завершения: ожидалось %s, получено %v", want, result)
	}
	if compare == nil {
		compare = func(want, got string) bool { return want == got }
	}
	if want, got := golden.ValueString(t, expected, "stdout"), normalize(result.Stdout); !compare(want, got) {
		t.Errorf("stdout:\n--- ожидалось\n%s\n--- получено\n%s", want, got)
	}
	wantErr, gotErr := golden.ValueString(t, expected, "stderr"), normalize(result.Stderr)
	checkStderr(t, expected, wantErr, gotErr, compare)
}

// caseArgs — аргументы случая после --project.
func caseArgs(spec *toolrt.Dict) []string {
	args := []string{}
	for _, arg := range spec.Value("args").([]any) {
		args = append(args, arg.(string))
	}
	return args
}

// TestContinuityBriefGolden запускает continuity_brief через tools.Run на входах эталона
// continuity-brief (checks-base с разностью случая) и сверяет код, stdout и stderr с эталоном;
// инструмент только читает проект.
func TestContinuityBriefGolden(t *testing.T) {
	for _, c := range golden.Load(t, "continuity-brief") {
		t.Run(c.Name, func(t *testing.T) {
			spec := c.ReadValue(t, "case.json")
			root := c.BuildProject(t)
			before, beforeErr := golden.TreeDigest(root)
			result, err := tools.Run(root, "continuity_brief", caseArgs(spec))
			if err != nil {
				t.Fatalf("tools.Run: %v", err)
			}
			checkStreams(t, c.ReadValue(t, "expected.json"), result, root, nil)
			if beforeErr == nil {
				if after, err := golden.TreeDigest(root); err != nil || after != before {
					t.Errorf("инструмент изменил проект: %v", err)
				}
			}
		})
	}
}

// cardRule — допустимое отличие списка карточек от эталона (internal/sceneviews, записано в
// testdata/golden/README.md): Go перерисовывает карточки, не подтверждённые квитанцией, и тогда
// перечисляет все ожидаемые карточки, а не только те, чьи пиксели изменились в эталоне.
// cards — все ожидаемые файлы карточек по квитанции эталона.
type cardRule struct{ cards []string }

// split — элементы списка, относящиеся к карточкам, и остальные (в исходном порядке).
func (r cardRule) split(list []string) (cards, rest []string) {
	known := map[string]bool{}
	for _, card := range r.cards {
		known[card] = true
	}
	for _, item := range list {
		if known[item] {
			cards = append(cards, item)
		} else {
			rest = append(rest, item)
		}
	}
	return cards, rest
}

// sameCards — карточки Go совпадают с эталоном либо это полный список ожидаемых карточек.
func (r cardRule) sameCards(want, got []string) bool {
	return strings.Join(want, "\n") == strings.Join(got, "\n") || strings.Join(got, "\n") == strings.Join(r.cards, "\n")
}

// compare — сравнение строки вывода с учётом правила карточек для «Устарели представления: …».
func (r cardRule) compare(want, got string) bool {
	const prefix = "Устарели представления: "
	if want == got {
		return true
	}
	if !strings.HasPrefix(want, prefix) || !strings.HasPrefix(got, prefix) {
		return false
	}
	parse := func(text string) []string {
		return strings.Split(strings.TrimSuffix(strings.TrimPrefix(text, prefix), "\n"), ", ")
	}
	wantCards, wantRest := r.split(parse(want))
	gotCards, gotRest := r.split(parse(got))
	return strings.Join(wantRest, "\n") == strings.Join(gotRest, "\n") && r.sameCards(wantCards, gotCards)
}

// treeFiles — файлы дерева проекта (путь через «/» → байты).
func treeFiles(t *testing.T, root string) map[string][]byte {
	t.Helper()
	files := map[string][]byte{}
	err := filepath.Walk(root, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		relative, _ := filepath.Rel(root, path)
		data, err := os.ReadFile(path)
		files[filepath.ToSlash(relative)] = data
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return files
}

// normalizeReceipt — квитанция карточек с маркером вместо SHA-256 файлов карточек: байты PNG
// эталоном не фиксируются (кодек может меняться), остальное содержимое квитанции сравнивается побайтно.
func normalizeReceipt(t *testing.T, data []byte) string {
	t.Helper()
	value, err := toolrt.LoadsJSON(string(data))
	if err != nil {
		t.Fatalf("квитанция карточек: %v", err)
	}
	cards := value.(*toolrt.Dict).Value("cards").(*toolrt.Dict)
	for _, sid := range cards.Keys() {
		entry := cards.Value(sid).(*toolrt.Dict)
		entry.Set("sha256", "<sha256>")
		if last, ok := entry.Value("last").(*toolrt.Dict); ok {
			last.Set("sha256", "<sha256>")
		}
	}
	text, err := toolrt.DumpsJSON(value, toolrt.DumpOptions{Indent: 2, Pretty: true})
	if err != nil {
		t.Fatal(err)
	}
	return text
}

// TestSceneViewsGolden запускает update_scene_views через tools.Run на входах эталона scene-views и
// сверяет с эталоном код, потоки, состояние файлов после записи (created/changed/removed), точные
// байты записанных текстовых файлов, квитанцию карточек (без SHA-256 PNG) и повторную проверку.
// Карточки сверяются по правилу cardRule; PNG Go — 1280×720, их SHA-256 в квитанции совпадает с
// файлами. Режим --check не меняет дерево.
func TestSceneViewsGolden(t *testing.T) {
	for _, c := range golden.Load(t, "scene-views") {
		t.Run(c.Name, func(t *testing.T) {
			spec := c.ReadValue(t, "case.json")
			expected := c.ReadValue(t, "expected.json")
			args := caseArgs(spec)
			rule := cardRule{}
			if cards, ok := expected.Value("cards").([]any); ok {
				for _, card := range cards {
					rule.cards = append(rule.cards, card.(string))
				}
			}
			root := c.BuildProject(t)
			before, beforeErr := golden.TreeDigest(root)
			var initial map[string][]byte
			if beforeErr == nil {
				initial = treeFiles(t, root)
			}
			result, err := tools.Run(root, "update_scene_views", args)
			if err != nil {
				t.Fatalf("tools.Run: %v", err)
			}
			states, writes := expected.Value("files").(*toolrt.Dict)
			if !writes {
				checkStreams(t, expected, result, root, rule.compare)
				if beforeErr == nil {
					if after, err := golden.TreeDigest(root); err != nil || after != before {
						t.Errorf("--check изменил проект: %v", err)
					}
				}
				return
			}
			after := treeFiles(t, root)
			gotStates := map[string]string{}
			for path := range initial {
				if _, ok := after[path]; !ok {
					gotStates[path] = "removed"
				}
			}
			for path, data := range after {
				previous, ok := initial[path]
				switch {
				case !ok:
					gotStates[path] = "created"
				case !bytes.Equal(previous, data):
					gotStates[path] = "changed"
				}
			}
			// Карточки: те же, что в эталоне, или все ожидаемые (перерисовка Go).
			wantCards, gotCards := []string{}, []string{}
			for _, card := range rule.cards {
				if states.Has(card) && states.Value(card) != "removed" {
					wantCards = append(wantCards, card)
				}
				if state, ok := gotStates[card]; ok && state != "removed" {
					gotCards = append(gotCards, card)
				}
			}
			if !rule.sameCards(wantCards, gotCards) {
				t.Errorf("перерисованные карточки: ожидалось %v (или все %v), получено %v", wantCards, rule.cards, gotCards)
			}
			// Перерисованная Go карточка имеет другой SHA-256, поэтому квитанция меняется и там, где
			// в эталоне байты карточек не изменились (лишняя запись квитанции в выводе и счёте).
			rerendered := len(gotCards) > 0
			extra := 0
			const receiptPath = "plan/animatic/cards/manifest.json"
			if rerendered && !states.Has(receiptPath) && gotStates[receiptPath] == "changed" {
				delete(gotStates, receiptPath)
				extra = 1
			}
			wantRest, gotRest := []string{}, []string{}
			for _, path := range states.Keys() {
				if !contains(wantCards, path) {
					wantRest = append(wantRest, path+" "+states.Value(path).(string))
				}
			}
			for path, state := range gotStates {
				if !contains(gotCards, path) {
					gotRest = append(gotRest, path+" "+state)
				}
			}
			sort.Strings(wantRest)
			sort.Strings(gotRest)
			if strings.Join(wantRest, "\n") != strings.Join(gotRest, "\n") {
				t.Errorf("изменения файлов:\n--- ожидалось\n%s\n--- получено\n%s", strings.Join(wantRest, "\n"), strings.Join(gotRest, "\n"))
			}
			for path, state := range gotStates {
				if state == "removed" {
					continue
				}
				data := after[path]
				switch {
				case strings.HasSuffix(path, ".png"):
					config, err := png.DecodeConfig(bytes.NewReader(data))
					if err != nil || config.Width != 1280 || config.Height != 720 {
						t.Errorf("%s: не PNG 1280×720: %v", path, err)
					}
				case path == "plan/animatic/cards/manifest.json":
					if want := c.Read(t, "files/"+path); normalizeReceipt(t, want) != normalizeReceipt(t, data) {
						t.Errorf("квитанция карточек:\n--- ожидалось\n%s\n--- получено\n%s", normalizeReceipt(t, want), normalizeReceipt(t, data))
					}
					checkReceiptDigests(t, root, data)
				default:
					if want := c.Read(t, "files/"+path); !bytes.Equal(want, data) {
						t.Errorf("байты %s:\n--- ожидалось\n%s\n--- получено\n%s", path, want, data)
					}
				}
			}
			// Счёт «Обновлено представлений: N» отличается ровно на разницу списков карточек и
			// лишнюю запись квитанции.
			wantOut := golden.ValueString(t, expected, "stdout")
			if delta := len(gotCards) - len(wantCards) + extra; delta != 0 && strings.HasPrefix(wantOut, "Обновлено представлений: ") {
				count, _ := toolrt.ParseInt(strings.TrimSuffix(strings.TrimPrefix(wantOut, "Обновлено представлений: "), ".\n"))
				value, _ := count.Int64()
				expected.Set("stdout", "Обновлено представлений: "+toolrt.NewInt(value+int64(delta)).String()+".\n")
			}
			checkStreams(t, expected, result, root, nil)
			recheck, ok := expected.Value("recheck").(*toolrt.Dict)
			if !ok {
				return
			}
			again, err := tools.Run(root, "update_scene_views", []string{"--check"})
			if err != nil {
				t.Fatal(err)
			}
			if !rerendered {
				// Карточки Go не рисовал: повторная проверка совпадает с эталоном.
				recheck.Set("unhandled", toolrt.IsUnhandled(golden.ValueString(t, recheck, "stderr")))
				checkStreams(t, recheck, again, root, rule.compare)
				return
			}
			// Свежесть аниматика в ROADMAP зависит от байтов карточек, поэтому после перерисовки
			// сверяется только то, что Go подтверждает свои карточки и квитанцию.
			if strings.Contains(again.Stderr, ".png") || strings.Contains(again.Stderr, receiptPath) || toolrt.IsUnhandled(again.Stderr) {
				t.Errorf("повторная проверка после записи Go: %s", again.Stderr)
			}
		})
	}
}

// checkReceiptDigests — SHA-256 карточек в квитанции Go совпадают с файлами на диске.
func checkReceiptDigests(t *testing.T, root string, data []byte) {
	t.Helper()
	value, _ := toolrt.LoadsJSON(string(data))
	cards := value.(*toolrt.Dict).Value("cards").(*toolrt.Dict)
	for _, sid := range cards.Keys() {
		entry := cards.Value(sid).(*toolrt.Dict)
		records := []*toolrt.Dict{entry}
		if last, ok := entry.Value("last").(*toolrt.Dict); ok {
			records = append(records, last)
		}
		for _, record := range records {
			path := record.Value("path").(string)
			actual, err := projectviews.FileSHA(filepath.Join(root, filepath.FromSlash(path)))
			if err != nil || actual != record.Value("sha256") {
				t.Errorf("квитанция: SHA-256 %s не совпадает с файлом (%v)", path, err)
			}
		}
	}
}

// contains — элемент в срезе строк.
func contains(list []string, item string) bool {
	for _, value := range list {
		if value == item {
			return true
		}
	}
	return false
}
