package tools_test

import (
	"bytes"
	"image/png"
	"os"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/projectviews"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/tools"
)

// checkStreams — сверка кода завершения и потоков результата tools.Run с эталоном
// (`<project>` вместо пути копии; у трассировки — заголовок и последняя строка). compare
// подменяет сравнение stdout/stderr, если оно не побайтное (список карточек scene-views).
func checkStreams(t *testing.T, expected *pycompat.Dict, result tools.Result, root string, compare func(want, got string) bool) {
	t.Helper()
	normalize := func(text string) string { return strings.ReplaceAll(text, root, golden.ProjectMarker) }
	if want := expected.Value("code").(pycompat.Int).String(); result.Code == nil || want != pycompat.NewInt(int64(*result.Code)).String() {
		t.Errorf("код завершения: ожидалось %s, получено %v", want, result)
	}
	if compare == nil {
		compare = func(want, got string) bool { return want == got }
	}
	if want, got := golden.PyString(t, expected, "stdout"), normalize(result.Stdout); !compare(want, got) {
		t.Errorf("stdout:\n--- ожидалось\n%s\n--- получено\n%s", want, got)
	}
	wantErr, gotErr := golden.PyString(t, expected, "stderr"), normalize(result.Stderr)
	if expected.Value("traceback") == true {
		if !strings.HasPrefix(gotErr, tracebackHeader+"\n") || lastLine(gotErr) != lastLine(wantErr) {
			t.Errorf("трассировка:\n--- ожидалось (последняя строка)\n%s\n--- получено\n%s", lastLine(wantErr), gotErr)
		}
	} else if !compare(wantErr, gotErr) {
		t.Errorf("stderr:\n--- ожидалось\n%s\n--- получено\n%s", wantErr, gotErr)
	}
}

// caseArgs — аргументы случая после --project.
func caseArgs(spec *pycompat.Dict) []string {
	args := []string{}
	for _, arg := range spec.Value("args").([]any) {
		args = append(args, arg.(string))
	}
	return args
}

// TestContinuityBriefGolden запускает continuity_brief через tools.Run на входах эталона
// continuity-brief (checks-base с разностью случая) и сверяет код, stdout и stderr с процессом
// оригинала; инструмент только читает проект.
func TestContinuityBriefGolden(t *testing.T) {
	for _, c := range golden.Load(t, "continuity-brief") {
		t.Run(c.Name, func(t *testing.T) {
			spec := c.PyRead(t, "case.json")
			root := c.BuildProject(t)
			before, beforeErr := golden.TreeDigest(root)
			result, err := tools.Run(root, "continuity_brief", caseArgs(spec))
			if err != nil {
				t.Fatalf("tools.Run: %v", err)
			}
			checkStreams(t, c.PyRead(t, "expected.json"), result, root, nil)
			if beforeErr == nil {
				if after, err := golden.TreeDigest(root); err != nil || after != before {
					t.Errorf("инструмент изменил проект: %v", err)
				}
			}
		})
	}
}

// cardRule — сознательное отличие Go от оригинала в списке карточек (internal/sceneviews): Go
// перерисовывает карточки, не подтверждённые квитанцией, и тогда перечисляет все ожидаемые
// карточки, а не только те, чьи пиксели изменились у Pillow. cards — все ожидаемые файлы
// карточек по квитанции оригинала.
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

// sameCards — карточки Go совпадают с оригиналом либо это полный список ожидаемых карточек.
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

// normalizeReceipt — квитанция карточек с маркером вместо SHA-256 файлов карточек: байты PNG Go
// не совпадают с Pillow, остальное содержимое квитанции сравнивается побайтно.
func normalizeReceipt(t *testing.T, data []byte) string {
	t.Helper()
	value, err := pycompat.LoadsJSON(string(data))
	if err != nil {
		t.Fatalf("квитанция карточек: %v", err)
	}
	cards := value.(*pycompat.Dict).Value("cards").(*pycompat.Dict)
	for _, sid := range cards.Keys() {
		entry := cards.Value(sid).(*pycompat.Dict)
		entry.Set("sha256", "<sha256>")
		if last, ok := entry.Value("last").(*pycompat.Dict); ok {
			last.Set("sha256", "<sha256>")
		}
	}
	text, err := pycompat.DumpsJSON(value, pycompat.DumpOptions{Indent: 2, Pretty: true})
	if err != nil {
		t.Fatal(err)
	}
	return text
}

// TestSceneViewsGolden запускает update_scene_views через tools.Run на входах эталона scene-views и
// сверяет с оригиналом код, потоки, состояние файлов после записи (created/changed/removed), точные
// байты записанных текстовых файлов, квитанцию карточек (без SHA-256 PNG) и повторную проверку.
// Карточки сверяются по правилу cardRule; PNG Go — 1280×720, их SHA-256 в квитанции совпадает с
// файлами. Режим --check не меняет дерево.
func TestSceneViewsGolden(t *testing.T) {
	for _, c := range golden.Load(t, "scene-views") {
		t.Run(c.Name, func(t *testing.T) {
			spec := c.PyRead(t, "case.json")
			expected := c.PyRead(t, "expected.json")
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
			states, writes := expected.Value("files").(*pycompat.Dict)
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
			// Карточки: те же, что у оригинала, или все ожидаемые (перерисовка Go).
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
			// у оригинала Pillow дал прежние байты (лишняя запись квитанции в выводе и счёте).
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
			wantOut := golden.PyString(t, expected, "stdout")
			if delta := len(gotCards) - len(wantCards) + extra; delta != 0 && strings.HasPrefix(wantOut, "Обновлено представлений: ") {
				count, _ := pycompat.ParseInt(strings.TrimSuffix(strings.TrimPrefix(wantOut, "Обновлено представлений: "), ".\n"))
				value, _ := count.Int64()
				expected.Set("stdout", "Обновлено представлений: "+pycompat.NewInt(value+int64(delta)).String()+".\n")
			}
			checkStreams(t, expected, result, root, nil)
			recheck, ok := expected.Value("recheck").(*pycompat.Dict)
			if !ok {
				return
			}
			again, err := tools.Run(root, "update_scene_views", []string{"--check"})
			if err != nil {
				t.Fatal(err)
			}
			if !rerendered {
				// Карточки Go не рисовал: повторная проверка совпадает с оригиналом.
				recheck.Set("traceback", strings.HasPrefix(golden.PyString(t, recheck, "stderr"), tracebackHeader))
				checkStreams(t, recheck, again, root, rule.compare)
				return
			}
			// Свежесть аниматика в ROADMAP зависит от байтов карточек, поэтому после перерисовки
			// сверяется только то, что Go подтверждает свои карточки и квитанцию.
			if strings.Contains(again.Stderr, ".png") || strings.Contains(again.Stderr, receiptPath) || strings.Contains(again.Stderr, tracebackHeader) {
				t.Errorf("повторная проверка после записи Go: %s", again.Stderr)
			}
		})
	}
}

// checkReceiptDigests — SHA-256 карточек в квитанции Go совпадают с файлами на диске.
func checkReceiptDigests(t *testing.T, root string, data []byte) {
	t.Helper()
	value, _ := pycompat.LoadsJSON(string(data))
	cards := value.(*pycompat.Dict).Value("cards").(*pycompat.Dict)
	for _, sid := range cards.Keys() {
		entry := cards.Value(sid).(*pycompat.Dict)
		records := []*pycompat.Dict{entry}
		if last, ok := entry.Value("last").(*pycompat.Dict); ok {
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

// TestSceneViewsSnapshotNotMigrated: проверка снимка Git (--check --staged, --check --ref) —
// инструмент разработчика оригинала, в Go-версии не перенесена: код 1, пояснение в stderr,
// проект не читается и не меняется. Без --check отказ argparse сверяет эталон scene-views.
func TestSceneViewsSnapshotNotMigrated(t *testing.T) {
	root := t.TempDir()
	for _, args := range [][]string{{"--check", "--staged"}, {"--check", "--ref", "HEAD"}, {"--ref=main", "--check"}} {
		result, err := tools.Run(root, "update_scene_views", args)
		if err != nil {
			t.Fatal(err)
		}
		want := "Проверка снимка Git — инструмент разработчика; в Go-версии SongFrame не перенесена.\n"
		if result.Code == nil || *result.Code != 1 || result.Stdout != "" || result.Stderr != want {
			t.Errorf("%v: %+v", args, result)
		}
	}
	if entries, err := os.ReadDir(root); err != nil || len(entries) != 0 {
		t.Errorf("проект изменён: %v %v", entries, err)
	}
}
