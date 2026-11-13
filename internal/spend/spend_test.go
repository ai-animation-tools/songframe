package spend

import (
	"encoding/json"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// request пишет запрос kind плана shot в папку dir проекта root с состоянием attempt.
func request(t *testing.T, root, dir, shot, kind string, attempt map[string]any) {
	t.Helper()
	folder := filepath.Join(root, filepath.FromSlash(dir))
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	write := func(name string, value any) {
		data, _ := json.Marshal(value)
		if err := os.WriteFile(filepath.Join(folder, name), data, 0o644); err != nil {
			t.Fatal(err)
		}
	}
	write("request.json", map[string]any{"schema_version": 1, "shot": shot, "kind": kind, "provider": "нет-такого"})
	write("attempt.json", attempt)
}

func sent(sha, id string, credits any) map[string]any {
	return map[string]any{"status": "downloaded", "request_sha256": sha, "generation_id": id, "credits_consumed": credits}
}

func entries(t *testing.T, root string) []Entry {
	t.Helper()
	result, err := Entries(root)
	if err != nil {
		t.Fatal(err)
	}
	return result
}

// TestSummaryWithRejectedAttempts — две попытки с опорой и двумя видео, принят второй дубль:
// суммы в исходных единицах, один отклонённый вариант и стоимость секунды. После Sync и удаления
// первой попытки (как при приёмке с очисткой) расход сохраняется, повторный Sync файл не меняет.
func TestSummaryWithRejectedAttempts(t *testing.T) {
	root := t.TempDir()
	request(t, root, "plan/batches/M02-attempt-01/image-01", "M02", "image", sent("i1", "img-1", 2))
	request(t, root, "plan/batches/M02-attempt-01/request", "M02", "video", sent("v1", "gen-1", 10))
	request(t, root, "plan/batches/M02-attempt-02/request", "M02", "video", sent("v2", "gen-2", 12.5))
	request(t, root, "plan/batches/M03-attempt-01/request", "M03", "video", sent("v3", "gen-3", 7))
	accepted := &Accepted{GenerationID: ptr("gen-2"), RequestSHA256: "v2", Seconds: 5}
	provider := ptr("нет-такого")
	want := Summary{Attempts: 2, Images: 1, Videos: 2, Rejected: 1, Totals: []Total{{Provider: provider, Amount: 24.5}}, AcceptedSeconds: ptrFloat(5),
		PerSecond: []Total{{Provider: provider, Amount: 4.9}}}
	if got := brief(Summarize(entries(t, root), "M02", accepted)); !reflect.DeepEqual(got, want) {
		t.Fatalf("сводка %+v", got)
	}
	if err := Sync(root); err != nil {
		t.Fatal(err)
	}
	journalPath := filepath.Join(root, "plan", "spend.json")
	before, err := os.ReadFile(journalPath)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(root, "plan/batches/M02-attempt-01")); err != nil {
		t.Fatal(err)
	}
	if got := brief(Summarize(entries(t, root), "M02", accepted)); !reflect.DeepEqual(got, want) {
		t.Fatalf("после удаления попытки %+v", got)
	}
	if err := Sync(root); err != nil {
		t.Fatal(err)
	}
	if after, _ := os.ReadFile(journalPath); string(after) != string(before) {
		t.Fatalf("повторный Sync изменил журнал:\n%s", after)
	}
}

// TestUnknownOutcome — неизвестный исход учитывается как отправка без суммы; «генерация не
// создана» снимает его, найденный номер генерации заменяет его одной записью.
func TestUnknownOutcome(t *testing.T) {
	root := t.TempDir()
	dir := "plan/batches/M04-attempt-01/request"
	request(t, root, dir, "M04", "video", map[string]any{"status": "submission_unknown", "request_sha256": "u1"})
	if err := Sync(root); err != nil {
		t.Fatal(err)
	}
	if got := Summarize(entries(t, root), "M04", nil); got.Unknown != 1 || got.Videos != 1 || len(got.Totals) != 0 {
		t.Fatalf("неизвестный исход %+v", got)
	}
	request(t, root, dir, "M04", "video", map[string]any{"status": "prepared", "request_sha256": "u1"})
	if err := Sync(root); err != nil {
		t.Fatal(err)
	}
	if got := entries(t, root); len(got) != 0 {
		t.Fatalf("не создана: %+v", got)
	}
	request(t, root, dir, "M04", "video", map[string]any{"status": "submission_unknown", "request_sha256": "u1"})
	if err := Sync(root); err != nil {
		t.Fatal(err)
	}
	request(t, root, dir, "M04", "video", sent("u1", "gen-9", nil))
	if got := entries(t, root); len(got) != 1 || got[0].Status != StatusSent || got[0].Amount != nil {
		t.Fatalf("найденный номер: %+v", got)
	}
}

// TestMovedAndRepeated — перенос попытки в очередь не удваивает отправку, повтор того же
// запроса с новым номером — отдельная отправка; ручная генерация без стоимости — неизвестный
// расход, со стоимостью — своя сумма отдельно от кредитов сервиса.
func TestMovedAndRepeated(t *testing.T) {
	root := t.TempDir()
	request(t, root, "plan/batches/M05-attempt-01/request", "M05", "video", sent("r1", "gen-1", 3))
	if err := Sync(root); err != nil {
		t.Fatal(err)
	}
	if err := os.MkdirAll(filepath.Join(root, "plan/awaiting"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.Rename(filepath.Join(root, "plan/batches/M05-attempt-01"), filepath.Join(root, "plan/awaiting/M05")); err != nil {
		t.Fatal(err)
	}
	request(t, root, "plan/batches/M05-attempt-02/request", "M05", "video", sent("r1", "gen-2", 3))
	request(t, root, "plan/batches/M05-attempt-03/request", "M05", "video",
		map[string]any{"status": "downloaded", "request_sha256": "m1", "manual_generation": map[string]any{"source": "сайт", "cost": nil}})
	request(t, root, "plan/batches/M05-attempt-04/request", "M05", "video",
		map[string]any{"status": "downloaded", "request_sha256": "m2", "manual_generation": map[string]any{"source": "сайт", "cost": map[string]any{"amount": 40, "unit": "credits"}}})
	got := brief(Summarize(entries(t, root), "M05", &Accepted{RequestSHA256: "m1", Seconds: 4}))
	provider, credits := ptr("нет-такого"), ptr("credits")
	want := Summary{Attempts: 4, Videos: 4, Rejected: 3, Unpriced: 1, Manual: 2, Totals: []Total{{Provider: provider, Amount: 6}, {Unit: credits, Amount: 40}},
		AcceptedSeconds: ptrFloat(4), PerSecond: []Total{{Provider: provider, Amount: 1.5}, {Unit: credits, Amount: 10}}}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("сводка %+v", got)
	}
}

// TestUnitsNotMixed — разные единицы, разные сервисы и неизвестная единица дают отдельные суммы.
func TestUnitsNotMixed(t *testing.T) {
	credits, tokens, a, b := "credits", "tokens", "a", "b"
	list := []Entry{
		{Shot: "M01", Attempt: "a", Kind: "video", Provider: a, Status: StatusSent, Amount: ptrFloat(5), Unit: &credits},
		{Shot: "M01", Attempt: "a", Kind: "image", Provider: b, Status: StatusSent, Amount: ptrFloat(2), Unit: &tokens},
		{Shot: "M01", Attempt: "b", Kind: "video", Provider: a, Status: StatusSent, Amount: ptrFloat(1), Unit: &credits},
		{Shot: "M01", Attempt: "b", Kind: "image", Provider: b, Status: StatusSent, Amount: ptrFloat(3), Unit: &credits},
		{Shot: "M01", Attempt: "b", Kind: "image", Provider: a, Status: StatusSent, Amount: ptrFloat(4)},
		{Shot: "M01", Attempt: "b", Kind: "image", Provider: a, Status: StatusSent},
	}
	got := Summarize(list, "M01", nil)
	want := []Total{{Provider: &a, Unit: &credits, Amount: 6}, {Provider: &b, Unit: &tokens, Amount: 2}, {Provider: &b, Unit: &credits, Amount: 3}, {Provider: &a, Amount: 4}}
	if !reflect.DeepEqual(got.Totals, want) || got.Unknown != 1 || got.Rejected != 0 || got.AcceptedSeconds != nil {
		t.Fatalf("сводка %+v", got)
	}
}

// TestDamagedJournal — повреждённый журнал не перезаписывается.
func TestDamagedJournal(t *testing.T) {
	root := t.TempDir()
	path := filepath.Join(root, "plan", "spend.json")
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("{"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := Sync(root); err == nil {
		t.Fatal("ждали ошибку")
	}
	if data, _ := os.ReadFile(path); string(data) != "{" {
		t.Fatal("журнал перезаписан")
	}
}

func ptr(value string) *string        { return &value }
func ptrFloat(value float64) *float64 { return &value }

// TestSyncDiscardingManual — удаление попытки с ручной генерацией убирает её стоимость из журнала,
// а удаление попытки с отправкой провайдеру расход сохраняет и показывает попытку удалённой.
func TestSyncDiscardingManual(t *testing.T) {
	root := t.TempDir()
	manual := map[string]any{"status": "downloaded", "request_sha256": "m1",
		"manual_generation": map[string]any{"cost": map[string]any{"amount": 180, "unit": "RUB"}}}
	request(t, root, "plan/batches/M02-attempt-01/request", "M02", "video", manual)
	request(t, root, "plan/batches/M02-attempt-02/request", "M02", "video", sent("v2", "gen-2", 10))
	if err := Sync(root); err != nil {
		t.Fatal(err)
	}
	if got := Summarize(entries(t, root), "M02", nil); got.Attempts != 2 || got.Removed != 0 || got.Manual != 1 {
		t.Fatalf("сводка до удаления %+v", got)
	}
	remove := func(attempt string) {
		t.Helper()
		if err := SyncDiscarding(root, attempt); err != nil {
			t.Fatal(err)
		}
		if err := os.RemoveAll(filepath.Join(root, filepath.FromSlash(attempt))); err != nil {
			t.Fatal(err)
		}
	}
	remove("plan/batches/M02-attempt-01")
	remove("plan/batches/M02-attempt-02")
	journal, err := readJournal(root)
	if err != nil {
		t.Fatal(err)
	}
	if len(journal) != 1 || journal[0].Status != StatusSent || journal[0].Attempt != "plan/batches/M02-attempt-02" {
		t.Fatalf("журнал после удаления попыток %+v", journal)
	}
	provider := ptr("нет-такого")
	want := Summary{Attempts: 1, Removed: 1, Videos: 1, Totals: []Total{{Provider: provider, Amount: 10}}, PerSecond: []Total{}}
	if got := brief(Summarize(entries(t, root), "M02", nil)); !reflect.DeepEqual(got, want) {
		t.Fatalf("сводка после удаления %+v", got)
	}
}

// brief — сводка без записей окна: тесты сумм сравнивают только счётчики и суммы.
func brief(summary Summary) Summary {
	summary.Entries = nil
	return summary
}
