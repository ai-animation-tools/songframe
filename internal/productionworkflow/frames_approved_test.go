package productionworkflow

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"path/filepath"
	"testing"

	"songframe/internal/dynvalue"
)

// TestFramesApprovedSingleAuto — одна опора, которую агент описания выбрал сам при числе опор «авто» (без
// keyframe_count), после утверждения считается принятым набором: иначе план застревает перед видеопромптом.
// Неутверждённая или изменённая опора и пустой список — не приняты.
func TestFramesApprovedSingleAuto(t *testing.T) {
	project := t.TempDir()
	dir := filepath.Join(project, "plan", "batches", "M01-attempt-01")
	if err := os.MkdirAll(filepath.Join(dir, "frames"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "frames", "K01.png"), tinyPNG, 0o644); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(tinyPNG)
	approved := func(frames string) bool {
		t.Helper()
		workflow, err := dynvalue.Parse([]byte(`{"stage":"keyframes_review","keyframes":` + frames + `}`))
		if err != nil {
			t.Fatal(err)
		}
		c := &Context{Project: project, PackageDir: dir, Workflow: workflow.(*dynvalue.Object)}
		result, err := c.FramesApproved()
		if err != nil {
			t.Fatal(err)
		}
		return result
	}
	frame := func(isApproved bool, digest string) string {
		value := "false"
		if isApproved {
			value = "true"
		}
		return `[{"id":"K01","role":"first","approved":` + value + `,"path":"frames/K01.png","sha256":"` + digest + `"}]`
	}
	if !approved(frame(true, hex.EncodeToString(sum[:]))) {
		t.Fatal("одна утверждённая опора без keyframe_count не принята")
	}
	if approved(frame(false, hex.EncodeToString(sum[:]))) || approved(frame(true, "чужой")) || approved(`[]`) {
		t.Fatal("неутверждённая, изменённая опора или пустой список приняты")
	}
}
