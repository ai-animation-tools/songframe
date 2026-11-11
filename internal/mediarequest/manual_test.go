package mediarequest

import (
	"context"
	"os"
	"path/filepath"
	"testing"
	"time"

	"songframe/internal/mediaadapters"
	"songframe/internal/requestsnapshot"
	"songframe/internal/toolrt"
)

// manualPackage собирает пакет ручной генерации провайдера id в новом проекте: опора PNG, срез WAV
// и промпт. Возвращает корень проекта и папку попытки.
func manualPackage(t *testing.T, id string) (string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	frame := filepath.Join(root, "plan", "batches", "M05-attempt-01", "keyframes", "K01.png")
	wav := filepath.Join(root, "plan", "batches", "M05-attempt-01", "audio", "speech.wav")
	for path, data := range map[string]string{frame: "\x89PNG\r\n\x1a\nкадр", wav: "RIFF....WAVEзвук"} {
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(data), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	work := filepath.Join(root, "plan", "batches", "M05-attempt-01", "request-01")
	result, err := requestsnapshot.PrepareManual(work, requestsnapshot.ManualSpec{
		Shot: "M05", Provider: id, Seconds: 5, Prompt: "Парень поёт.",
		Inputs: []requestsnapshot.ManualInput{{Path: frame, Slot: "image", Role: "Опора K01"}, {Path: wav, Slot: "audio", Role: "Срез речи"}},
	})
	if err != nil {
		t.Fatal(err)
	}
	if result.Value("mode") != "manual" || result.Value("command") != nil || result.Value("model") != nil {
		t.Fatalf("запрос ручной генерации: %v", result)
	}
	return root, work
}

// TestAttachManual — видео ручной генерации становится оригиналом с SHA и сведениями
// manual_generation; повторная загрузка и отправка сервису запрещены.
func TestAttachManual(t *testing.T) {
	defer mediaadapters.Register("manual-test", silentAdapter{})()
	root, work := manualPackage(t, "manual-test")
	_, state, err := LoadAttempt(work, true)
	if err != nil || state.Value("status") != "manual_pending" {
		t.Fatalf("статус до загрузки %v, %v", state.Value("status"), err)
	}
	if _, err := Submit(context.Background(), root, work, toolrt.Str(state.Value("request_sha256")), 60); err == nil || err.Error() != textManualRequest {
		t.Fatalf("отправка ручного пакета: %v", err)
	}
	video := filepath.Join(t.TempDir(), "kling_avatar.mp4")
	if err := os.WriteFile(video, []byte("\x00\x00\x00\x18ftypmp42видео"), 0o644); err != nil {
		t.Fatal(err)
	}
	if _, err := AttachManual(root, work, video, ManualMeta{Source: "  "}); err == nil || err.Error() != textManualSource {
		t.Fatalf("пустой источник: %v", err)
	}
	amount := 75.0
	if _, err := AttachManual(root, work, video, ManualMeta{Source: "Kling", CostAmount: &amount, CostUnit: "EUR"}); err == nil || err.Error() != textManualCostUnit {
		t.Fatalf("неизвестная единица: %v", err)
	}
	defer func(previous func() time.Time) { utcNow = previous }(utcNow)
	utcNow = func() time.Time { return time.Date(2026, 11, 12, 11, 5, 0, 0, time.UTC) }
	result, err := AttachManual(root, work, video, ManualMeta{Source: " Kling Avatar на сайте ", CostAmount: &amount, CostUnit: "credits", Note: "Вторая попытка"})
	if err != nil {
		t.Fatal(err)
	}
	generation := result.Value("manual_generation").(*toolrt.Dict)
	cost := generation.Value("cost").(*toolrt.Dict)
	if result.Value("status") != "downloaded" || result.Value("manual_result") != true || generation.Value("source") != "Kling Avatar на сайте" ||
		generation.Value("original_name") != "kling_avatar.mp4" || generation.Value("attached_at") != "2026-11-12T11:05:00Z" ||
		cost.Value("unit") != "credits" || toolrt.Str(cost.Value("amount")) != "75" || generation.Value("description") != "Вторая попытка" {
		t.Fatalf("сведения загрузки: %v", generation)
	}
	download := result.Value("downloads").([]any)[0].(*toolrt.Dict)
	digest, _ := requestsnapshot.FileSHA(video)
	if download.Value("path") != "original.mp4" || download.Value("sha256") != digest {
		t.Fatalf("оригинал: %v", download)
	}
	if _, err := AttachManual(root, work, video, ManualMeta{Source: "Kling"}); err == nil || err.Error() != textNotManual {
		t.Fatalf("повторная загрузка: %v", err)
	}
	if _, err := Resume(context.Background(), root, work, "", 0, 15, 60); err != nil {
		t.Fatalf("получение загруженного видео: %v", err)
	}
}

// TestAttachManualWithoutCost — без стоимости и примечания поля записываются null.
func TestAttachManualWithoutCost(t *testing.T) {
	defer mediaadapters.Register("manual-test", silentAdapter{})()
	root, work := manualPackage(t, "manual-test")
	video := filepath.Join(t.TempDir(), "own.mp4")
	if err := os.WriteFile(video, []byte("\x00\x00\x00\x18ftypisomсвоё"), 0o644); err != nil {
		t.Fatal(err)
	}
	result, err := AttachManual(root, work, video, ManualMeta{Source: "своё видео"})
	if err != nil {
		t.Fatal(err)
	}
	generation := result.Value("manual_generation").(*toolrt.Dict)
	if !generation.Has("cost") || generation.Value("cost") != nil || !generation.Has("description") || generation.Value("description") != nil {
		t.Fatalf("необязательные поля: %v", generation)
	}
}
