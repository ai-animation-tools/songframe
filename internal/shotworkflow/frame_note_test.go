package shotworkflow

import (
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeFrameNotePackage — минимальный workflow.json с неутверждённой K01 и утверждённой K02.
func writeFrameNotePackage(t *testing.T) string {
	t.Helper()
	directory := t.TempDir()
	document := `{"schema_version":1,"shot":"M01","mode":"shot","stage":"keyframes_review","wait_reason":null,` +
		`"request_dir":null,"description_approved":true,"scene_sha256":"x","timing":{},` +
		`"keyframes":[{"id":"K01","approved":false},{"id":"K02","approved":true}],"approved_frames":{},` +
		`"keyframe_notes":[],"prompt":{"path":"video-prompt.txt","approved":false},"approved_prompt_sha256":null,` +
		`"retry_of":null,"frame_source":null,"model":null,"batch":null,"current_keyframe":"K01",` +
		`"pending_decision":null,"decision":null}`
	if err := os.WriteFile(filepath.Join(directory, "workflow.json"), []byte(document), 0o644); err != nil {
		t.Fatal(err)
	}
	return directory
}

// Указание становится обычным действующим замечанием к опоре с выбранной областью.
func TestAddFrameNoteWritesActiveNote(t *testing.T) {
	directory := writeFrameNotePackage(t)
	if err := AddFrameNote(directory, "K01", "  Иван смотрит в камеру  ", "frame"); err != nil {
		t.Fatal(err)
	}
	data, err := load(directory)
	if err != nil {
		t.Fatal(err)
	}
	notes := data.Value("keyframe_notes").([]any)
	if len(notes) != 1 {
		t.Fatalf("замечаний %d", len(notes))
	}
	note, _ := get(notes[0], "note", nil)
	scope, _ := get(notes[0], "scope", nil)
	active, _ := get(notes[0], "active", nil)
	if note != "Иван смотрит в камеру" || scope != "frame" || active != true {
		t.Fatalf("запись %v", notes[0])
	}
}

// Утверждённую опору меняет только возврат на доработку; пустое указание не записывается.
func TestAddFrameNoteRejectsApprovedAndEmpty(t *testing.T) {
	directory := writeFrameNotePackage(t)
	if err := AddFrameNote(directory, "K02", "текст", "frame"); err == nil || !strings.Contains(err.Error(), "утверждена") {
		t.Fatalf("утверждённая опора: %v", err)
	}
	if err := AddFrameNote(directory, "K01", "   ", "frame"); err == nil {
		t.Fatal("пустое указание принято")
	}
}
