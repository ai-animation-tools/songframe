package shotworkflow

import (
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeImage — «изображение» с заданным содержимым: инструмент проверяет только расширение и байты.
func writeImage(t *testing.T, path, content string) string {
	t.Helper()
	if err := os.WriteFile(path, []byte(content), 0o644); err != nil {
		t.Fatal(err)
	}
	return path
}

// fixedNow подменяет время отметок: каждый вызов — следующая секунда, имена вариантов различаются.
func fixedNow(t *testing.T) {
	t.Helper()
	previous := Now
	second := 0
	Now = func() string {
		second++
		return fmt.Sprintf("2026-11-26T14:%02d:%02d+00:00", second/60, second%60)
	}
	t.Cleanup(func() { Now = previous })
}

func frameBytes(t *testing.T, directory, id string) string {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(directory, "frames", id+".png"))
	if err != nil {
		t.Fatal(err)
	}
	return string(data)
}

// Новый кандидат не стирает прежний: тот уходит в историю с отметкой генератора и возвращается
// кандидатом вместе с ней, а заменённый при возврате файл сам становится прежним вариантом.
func TestFrameVariantsKeepAndRestore(t *testing.T) {
	fixedNow(t)
	directory := writeFrameNotePackage(t)
	outside := t.TempDir()
	tool := &workflowTool{}
	if _, err := tool.approve(directory, "K01", writeImage(t, filepath.Join(outside, "first.png"), "первый"), true); err != nil {
		t.Fatal(err)
	}
	// Отметку генератора ставит производство после предложения кандидата.
	data, _ := load(directory)
	keyframe, _ := keyframeOf(data, "K01")
	keyframe.Set("provider", "codex")
	keyframe.Set("generator_prompt", "промпт первого")
	if _, err := save(directory, data); err != nil {
		t.Fatal(err)
	}
	if _, err := tool.approve(directory, "K01", writeImage(t, filepath.Join(outside, "second.png"), "второй"), true); err != nil {
		t.Fatal(err)
	}
	if got := frameBytes(t, directory, "K01"); got != "второй" {
		t.Fatalf("текущая опора %q", got)
	}
	variants, err := FrameVariants(directory, "K01")
	if err != nil || len(variants) != 1 {
		t.Fatalf("варианты %v, %v", variants, err)
	}
	if data, _ := os.ReadFile(variants[0].ImagePath); string(data) != "первый" {
		t.Fatalf("прежний вариант %q", data)
	}
	// Тот же файл ещё раз — не новый вариант.
	if _, err := tool.approve(directory, "K01", filepath.Join(outside, "second.png"), true); err != nil {
		t.Fatal(err)
	}
	if variants, _ := FrameVariants(directory, "K01"); len(variants) != 1 {
		t.Fatalf("повтор того же файла дал вариант: %v", variants)
	}

	if err := RestoreFrameVariant(directory, "K01", variants[0].Name); err != nil {
		t.Fatal(err)
	}
	if got := frameBytes(t, directory, "K01"); got != "первый" {
		t.Fatalf("после возврата %q", got)
	}
	data, _ = load(directory)
	keyframe, _ = keyframeOf(data, "K01")
	if keyframe.Value("approved") != false || keyframe.Value("provider") != "codex" || keyframe.Value("generator_prompt") != "промпт первого" {
		t.Fatalf("опора после возврата: %v", keyframe)
	}
	if data.Value("stage") != "keyframes_review" || data.Value("pending_decision") != nil {
		t.Fatalf("этап %v, вопрос %v", data.Value("stage"), data.Value("pending_decision"))
	}
	variants, _ = FrameVariants(directory, "K01")
	if len(variants) != 1 {
		t.Fatalf("после возврата вариантов %d", len(variants))
	}
	if data, _ := os.ReadFile(variants[0].ImagePath); string(data) != "второй" {
		t.Fatalf("заменённый при возврате файл %q", data)
	}
}

// Хранятся пять последних вариантов опоры: старшие удаляются вместе с записью.
func TestFrameVariantsPruned(t *testing.T) {
	fixedNow(t)
	directory := writeFrameNotePackage(t)
	outside := t.TempDir()
	tool := &workflowTool{}
	for index := range 8 {
		path := writeImage(t, filepath.Join(outside, fmt.Sprintf("k%d.png", index)), fmt.Sprintf("вариант %d", index))
		if _, err := tool.approve(directory, "K01", path, true); err != nil {
			t.Fatal(err)
		}
	}
	variants, err := FrameVariants(directory, "K01")
	if err != nil || len(variants) != historyKeep {
		t.Fatalf("варианты %d, %v", len(variants), err)
	}
	if data, _ := os.ReadFile(variants[0].ImagePath); string(data) != "вариант 6" {
		t.Fatalf("новейший прежний вариант %q", data)
	}
	entries, _ := os.ReadDir(historyDir(directory))
	if len(entries) != 2*historyKeep {
		t.Fatalf("файлов в истории %d", len(entries))
	}
}

// Вернуть вариант нельзя после утверждения видеопромпта; чужое имя варианта не принимается.
func TestRestoreFrameVariantGuards(t *testing.T) {
	fixedNow(t)
	directory := writeFrameNotePackage(t)
	outside := t.TempDir()
	tool := &workflowTool{}
	for _, content := range []string{"а", "б"} {
		if _, err := tool.approve(directory, "K01", writeImage(t, filepath.Join(outside, content+".png"), content), true); err != nil {
			t.Fatal(err)
		}
	}
	variants, _ := FrameVariants(directory, "K01")
	if err := RestoreFrameVariant(directory, "K02", variants[0].Name); err == nil {
		t.Fatal("вариант другой опоры принят")
	}
	if err := RestoreFrameVariant(directory, "K01", "../K01-x"); err == nil {
		t.Fatal("путь вместо имени принят")
	}
	data, _ := load(directory)
	data.Value("prompt").(interface{ Set(string, any) }).Set("approved", true)
	if _, err := save(directory, data); err != nil {
		t.Fatal(err)
	}
	if err := RestoreFrameVariant(directory, "K01", variants[0].Name); err == nil || !strings.Contains(err.Error(), "утверждён") {
		t.Fatalf("после утверждения промпта: %v", err)
	}
}
