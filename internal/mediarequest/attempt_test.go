package mediarequest

import (
	"context"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"testing"
	"time"

	"songframe-go/internal/mediaadapters"
	"songframe-go/internal/mediaapi"
	"songframe-go/internal/pycompat"
)

// TestUUID7 — формат RFC 9562 (версия 7, вариант 10) и время в первых 48 битах.
func TestUUID7(t *testing.T) {
	pattern := regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$`)
	before := time.Now().UnixMilli()
	value := uuid7()
	if !pattern.MatchString(value) {
		t.Fatalf("не UUID v7: %s", value)
	}
	milliseconds, err := strconv.ParseInt(value[0:8]+value[9:13], 16, 64)
	if err != nil {
		t.Fatal(err)
	}
	if milliseconds < before || milliseconds > time.Now().UnixMilli() {
		t.Fatalf("время UUID %d вне [%d, now]", milliseconds, before)
	}
	if uuid7() == value {
		t.Fatal("два UUID совпали")
	}
}

// cancellingAdapter — адаптер, у которого задание отменяют посреди отправки.
type cancellingAdapter struct{ cancel context.CancelFunc }

func (a cancellingAdapter) Submit(ctx context.Context, _ string, _, _ *pycompat.Dict, _ time.Duration) (mediaapi.SubmitResult, error) {
	a.cancel()
	return mediaapi.SubmitResult{}, ctx.Err()
}

// silentAdapter — адаптер без отправки (Submitter не реализован).
type silentAdapter struct{}

// prepared готовит попытку провайдера id в новом проекте и возвращает корень, папку и SHA.
func prepared(t *testing.T, id string) (string, string, string) {
	t.Helper()
	root, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	files := map[string]string{
		"request/spec.json":  `{"schema_version": 1, "provider": "` + id + `", "kind": "video", "command": "text_to_video", "model": "m", "prompt_file": "prompt.txt"}`,
		"request/prompt.txt": "Кадр.",
	}
	for name, text := range files {
		path := filepath.Join(root, name)
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	work := filepath.Join(root, "plan", "batches", "a", "request")
	result, err := Prepare(root, filepath.Join(root, "request", "spec.json"), work)
	if err != nil {
		t.Fatal(err)
	}
	return root, work, result.Value("request_sha256").(string)
}

// TestSubmitCancelled — отмена задания посреди отправки равна обрыву процесса: попытка остаётся
// submitting, повторная отправка запрещена, исход выясняется через not-created или resume.
func TestSubmitCancelled(t *testing.T) {
	ctx, cancel := context.WithCancel(context.Background())
	defer mediaadapters.Register("cancelling", cancellingAdapter{cancel: cancel})()
	root, work, sha := prepared(t, "cancelling")
	if _, err := Submit(ctx, root, work, sha, 60); err == nil || ctx.Err() == nil {
		t.Fatalf("ожидалась отмена, получено %v", err)
	}
	_, state, err := LoadAttempt(work, false)
	if err != nil || state.Value("status") != "submitting" {
		t.Fatalf("статус %v, %v", state.Value("status"), err)
	}
	if _, err := Submit(context.Background(), root, work, sha, 60); err == nil || err.Error() != textAlreadySent {
		t.Fatalf("повтор после отмены: %v", err)
	}
	if result, err := NotCreated(root, work); err != nil || result.Value("status") != "prepared" {
		t.Fatalf("not-created: %v", err)
	}
}

// TestSubmitUnsupported — адаптер без отправки отклоняется до записи submitting.
func TestSubmitUnsupported(t *testing.T) {
	defer mediaadapters.Register("silent", silentAdapter{})()
	root, work, sha := prepared(t, "silent")
	if _, err := Submit(context.Background(), root, work, sha, 60); err == nil || err.Error() != "Провайдер 'silent' не поддерживает это действие." {
		t.Fatalf("ожидался отказ, получено %v", err)
	}
	if _, state, err := LoadAttempt(work, false); err != nil || state.Value("status") != "prepared" {
		t.Fatalf("статус %v, %v", state.Value("status"), err)
	}
}

// TestWorkPathReferenceArchive — попытка референса живёт в архиве plan/reference-images/<ID>;
// сам корень архива попыткой не бывает.
func TestWorkPathReferenceArchive(t *testing.T) {
	root := t.TempDir()
	attempt := filepath.Join(root, "plan", "reference-images", "session", "image-jobs", "job")
	if err := os.MkdirAll(attempt, 0o755); err != nil {
		t.Fatal(err)
	}
	if path, err := WorkPath(root, attempt); err != nil || path != attempt {
		t.Fatalf("попытка в архиве референса: %q, %v", path, err)
	}
	archive := filepath.Join(root, "plan", "reference-images")
	if _, err := WorkPath(root, archive); err == nil || err.Error() != textWorkDir {
		t.Fatalf("корень архива: ожидался отказ %q, получено %v", textWorkDir, err)
	}
}
