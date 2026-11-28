package production

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
)

// writeAttempt пишет в папку попытки workflow.json с полями extra после обязательных и возвращает её.
func writeAttempt(t *testing.T, project, extra string) string {
	t.Helper()
	dir := filepath.Join(project, "plan", "batches", "M01-attempt-01")
	if err := os.MkdirAll(filepath.Join(dir, "references"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(dir, "references", "R01.png"), []byte("png"), 0o644); err != nil {
		t.Fatal(err)
	}
	document := `{"schema_version":1,"shot":"M01","mode":"shot","stage":"description_review","wait_reason":null,` +
		`"request_dir":null,"description_approved":false,"timing":{},"keyframes":[],"approved_frames":{},"keyframe_notes":[],` + extra +
		`"prompt":{"path":"video-prompt.txt","approved":false},"approved_prompt_sha256":null,"retry_of":null,"frame_source":null,` +
		`"model":null,"batch":null,"current_keyframe":null,"pending_decision":null,"decision":null}`
	if err := os.WriteFile(filepath.Join(dir, "workflow.json"), []byte(document), 0o644); err != nil {
		t.Fatal(err)
	}
	return dir
}

// У попытки по референсам вид пакета несёт способ и картинки: роль, сущность, исходный путь,
// абсолютный путь копии, если файл есть, и утверждение; у попытки по опорам полей нет и в JSON их
// тоже нет.
func TestReadPackageReferences(t *testing.T) {
	project := t.TempDir()
	dir := writeAttempt(t, project, `"generation_method":"references","references":[`+
		`{"id":"R01","role":"start","entity":null,"source":"plan/batches/M00-attempt-01/continuity/M00-last.png","path":"references/R01.png","sha256":"a","approved":true},`+
		`{"id":"R02","role":"entity","entity":"mira","source":"source/heroes/mira.png","path":"references/R02.png","sha256":"b","approved":false},`+
		`{"id":"R03","role":"entity","entity":"boat","path":"references/R03.png","sha256":"c","approved":false}],`)
	pkg, err := ReadPackage(project, dir)
	if err != nil || pkg == nil {
		t.Fatalf("пакет: %v %v", pkg, err)
	}
	if pkg.GenerationMethod != "references" || len(pkg.References) != 3 || len(pkg.Keyframes) != 0 {
		t.Fatalf("способ %q, референсов %d", pkg.GenerationMethod, len(pkg.References))
	}
	first, second, third := pkg.References[0], pkg.References[1], pkg.References[2]
	if first.ID != "R01" || first.Role != "start" || first.Entity != nil || !first.Approved || first.Version != "a" ||
		first.Source == nil || !strings.HasSuffix(*first.Source, "M00-last.png") || first.ImagePath == nil || *first.ImagePath != filepath.Join(dir, "references", "R01.png") {
		t.Fatalf("R01: %+v", first)
	}
	if second.Entity == nil || *second.Entity != "mira" || second.Approved || second.ImagePath != nil {
		t.Fatalf("R02 без файла: %+v", second)
	}
	if third.Source != nil || third.ImagePath != nil {
		t.Fatalf("R03 без источника: %+v", third)
	}
	data, err := json.Marshal(pkg)
	if err != nil {
		t.Fatal(err)
	}
	if !strings.Contains(string(data), `"generationMethod":"references"`) || !strings.Contains(string(data), `"references":[`) {
		t.Fatalf("JSON попытки по референсам: %s", data)
	}
	// Нестроковый путь копии — ошибка вызова, как у опор.
	bad := writeAttempt(t, project, `"generation_method":"references","references":[{"id":"R01","role":"start","path":5,"approved":false}],`)
	if _, err := ReadPackage(project, bad); err == nil {
		t.Fatal("нестроковый путь принят")
	}
}

// Попытка по опорам не получает способа и референсов: ни в виде, ни в JSON.
func TestReadPackageWithoutReferences(t *testing.T) {
	project := t.TempDir()
	dir := writeAttempt(t, project, ``)
	pkg, err := ReadPackage(project, dir)
	if err != nil || pkg == nil {
		t.Fatalf("пакет: %v %v", pkg, err)
	}
	if pkg.GenerationMethod != "" || pkg.References != nil {
		t.Fatalf("способ %q, референсы %v", pkg.GenerationMethod, pkg.References)
	}
	data, err := json.Marshal(pkg)
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(string(data), "generationMethod") || strings.Contains(string(data), `"references"`) {
		t.Fatalf("JSON попытки по опорам: %s", data)
	}
}
