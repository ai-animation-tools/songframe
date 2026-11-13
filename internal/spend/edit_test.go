package spend

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// workflow пишет workflow.json попытки dir с утверждёнными опорами frames и выбранными из
// запросов изображений файлами generated.
func workflow(t *testing.T, root, dir, shot string, frames map[string]string, generated ...string) {
	t.Helper()
	requests := []map[string]any{}
	for _, sha := range generated {
		requests = append(requests, map[string]any{"selected_sha256": sha})
	}
	data, _ := json.Marshal(map[string]any{"shot": shot, "approved_frames": frames, "image_requests": requests})
	folder := filepath.Join(root, filepath.FromSlash(dir))
	if err := os.MkdirAll(folder, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(folder, "workflow.json"), data, 0o644); err != nil {
		t.Fatal(err)
	}
}

func viewOf(t *testing.T, summary Summary, match func(EntryView) bool) EntryView {
	t.Helper()
	for _, entry := range summary.Entries {
		if match(entry) {
			return entry
		}
	}
	t.Fatalf("записи нет: %+v", summary.Entries)
	return EntryView{}
}

// TestOwnFrameCost — своя опора (не выбранная из запроса изображения) — запись без суммы и без
// тревоги «цена не указана». Указанная стоимость живёт в журнале, переживает Sync и приёмку с
// очисткой; замена файла опоры — другая запись; удаление попытки убирает свои опоры.
func TestOwnFrameCost(t *testing.T) {
	root := t.TempDir()
	attempt := "plan/batches/M01-attempt-01"
	workflow(t, root, attempt, "M01", map[string]string{"K01": "own-1", "K02": "gen-1"}, "gen-1")
	request(t, root, attempt+"/image-K02-1", "M01", "image", sent("i1", "img-1", 3))
	summary := Summarize(entries(t, root), "M01", nil)
	if summary.OwnImages != 1 || summary.Images != 1 || summary.Unpriced != 0 || summary.Unknown != 0 {
		t.Fatalf("своя опора: %+v", summary)
	}
	own := viewOf(t, summary, func(entry EntryView) bool { return entry.Frame == "K01" })
	if !own.Editable || own.Amount != nil || own.Provider != nil {
		t.Fatalf("запись своей опоры: %+v", own)
	}
	amount := 20.0
	if err := SetAmount(root, own.Ref, &amount, "RUB"); err != nil {
		t.Fatal(err)
	}
	if err := Sync(root); err != nil {
		t.Fatal(err)
	}
	summary = Summarize(entries(t, root), "M01", nil)
	if len(summary.Totals) != 2 || summary.Totals[1].Amount != 20 || *summary.Totals[1].Unit != "RUB" || summary.Totals[1].Provider != nil {
		t.Fatalf("стоимость своей опоры: %+v", summary.Totals)
	}
	// Опора заменена другим файлом: прежняя стоимость к ней не относится.
	workflow(t, root, attempt, "M01", map[string]string{"K01": "own-2", "K02": "gen-1"}, "gen-1")
	if got := viewOf(t, Summarize(entries(t, root), "M01", nil), func(entry EntryView) bool { return entry.Ref.FileSHA256 == "own-2" }); got.Amount != nil {
		t.Fatalf("заменённая опора унаследовала стоимость: %+v", got)
	}
	if err := SyncDiscarding(root, attempt); err != nil {
		t.Fatal(err)
	}
	if err := os.RemoveAll(filepath.Join(root, filepath.FromSlash(attempt))); err != nil {
		t.Fatal(err)
	}
	if summary := Summarize(entries(t, root), "M01", nil); summary.OwnImages != 0 || summary.Images != 1 {
		t.Fatalf("после удаления попытки: %+v", summary)
	}
}

// TestUserAmountForUnknownCharge — сумма вместо неизвестного списания хранится в журнале и не
// стирается живым состоянием; списание, сообщённое сервисом, правке не подлежит; исправленная
// цена ручной генерации заменяет цену из попытки, не меняя её файлов.
func TestUserAmountForUnknownCharge(t *testing.T) {
	root := t.TempDir()
	request(t, root, "plan/batches/M02-attempt-01/request", "M02", "video", sent("v1", "gen-1", nil))
	request(t, root, "plan/batches/M02-attempt-02/request", "M02", "video", sent("v2", "gen-2", 9))
	request(t, root, "plan/batches/M02-attempt-03/request", "M02", "video", map[string]any{
		"status": "downloaded", "request_sha256": "m1", "manual_generation": map[string]any{"source": "сайт"},
	})
	summary := Summarize(entries(t, root), "M02", nil)
	if summary.Unknown != 1 || summary.Unpriced != 1 {
		t.Fatalf("до правки: %+v", summary)
	}
	amount := 15.0
	unknown := viewOf(t, summary, func(entry EntryView) bool { return entry.Ref.RequestSHA256 == "v1" })
	if err := SetAmount(root, unknown.Ref, &amount, "credits"); err != nil {
		t.Fatal(err)
	}
	reported := viewOf(t, summary, func(entry EntryView) bool { return entry.Ref.RequestSHA256 == "v2" })
	if reported.Editable || SetAmount(root, reported.Ref, &amount, "credits") == nil {
		t.Fatal("сумма сервиса правится")
	}
	manual := viewOf(t, summary, func(entry EntryView) bool { return entry.Ref.RequestSHA256 == "m1" })
	if err := SetAmount(root, manual.Ref, &amount, "RUB"); err != nil {
		t.Fatal(err)
	}
	if err := Sync(root); err != nil {
		t.Fatal(err)
	}
	summary = Summarize(entries(t, root), "M02", nil)
	got := viewOf(t, summary, func(entry EntryView) bool { return entry.Ref.RequestSHA256 == "v1" })
	if summary.Unknown != 0 || summary.Unpriced != 0 || got.Amount == nil || *got.Amount != 15 || !got.UserAmount || !got.Editable {
		t.Fatalf("после правки: %+v %+v", summary, got)
	}
	// Стоимость ручной генерации исправлена в журнале, попытка не тронута.
	if data, _ := os.ReadFile(filepath.Join(root, "plan/batches/M02-attempt-03/request/attempt.json")); strings.Contains(string(data), "cost") {
		t.Fatalf("правка попала в попытку: %s", data)
	}
	// Цена, указанная при загрузке, заменяется исправленной.
	request(t, root, "plan/batches/M02-attempt-03/request", "M02", "video", map[string]any{
		"status": "downloaded", "request_sha256": "m1", "manual_generation": map[string]any{"source": "сайт", "cost": map[string]any{"amount": 99, "unit": "USD"}},
	})
	fixed := viewOf(t, Summarize(entries(t, root), "M02", nil), func(entry EntryView) bool { return entry.Ref.RequestSHA256 == "m1" })
	if *fixed.Amount != 15 || *fixed.Unit != "RUB" {
		t.Fatalf("исправленная цена ручной генерации: %+v", fixed)
	}
	if err := SetAmount(root, got.Ref, nil, ""); err != nil {
		t.Fatal(err)
	}
	if summary := Summarize(entries(t, root), "M02", nil); summary.Unknown != 1 {
		t.Fatalf("снятая сумма: %+v", summary)
	}
	if SetAmount(root, got.Ref, &amount, "EUR") == nil || SetAmount(root, got.Ref, ptrFloat(1.5), "RUB") == nil {
		t.Fatal("недопустимая сумма принята")
	}
}

// TestAcceptedWithoutEntry — принятый план без записи принятого видео: «цена не указана»; цена,
// указанная по комплекту, узнаётся как принятое видео, правится и не добавляется второй раз.
func TestAcceptedWithoutEntry(t *testing.T) {
	root := t.TempDir()
	accepted := &Accepted{RequestSHA256: "kit-1", Seconds: 4}
	summary := Summarize(entries(t, root), "M05", accepted)
	if !summary.Missing || summary.Unpriced != 1 || summary.Rejected != 0 {
		t.Fatalf("без записи: %+v", summary)
	}
	kit := Kit{Shot: "M05", Provider: "нет-такого", RequestSHA256: "kit-1"}
	if err := AddAccepted(root, kit, 120, "credits"); err != nil {
		t.Fatal(err)
	}
	summary = Summarize(entries(t, root), "M05", accepted)
	if summary.Missing || summary.Unpriced != 0 || summary.Videos != 1 || summary.Rejected != 0 || summary.Totals[0].Amount != 120 {
		t.Fatalf("с ценой комплекта: %+v", summary)
	}
	entry := summary.Entries[0]
	if !entry.Kit || !entry.Accepted || !entry.Editable || entry.Removed {
		t.Fatalf("запись комплекта: %+v", entry)
	}
	if AddAccepted(root, kit, 1, "credits") == nil {
		t.Fatal("вторая цена комплекта")
	}
	if err := SetAmount(root, entry.Ref, ptrFloat(100), "RUB"); err != nil {
		t.Fatal(err)
	}
	if summary := Summarize(entries(t, root), "M05", accepted); *summary.Totals[0].Unit != "RUB" || summary.Totals[0].Amount != 100 {
		t.Fatalf("исправленная цена: %+v", summary.Totals)
	}
}
