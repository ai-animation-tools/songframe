package app

import (
	"context"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/mediatest"
	"songframe/internal/productionworkflow"
	"songframe/internal/savedlooks"
	"songframe/internal/toolrt"
)

// looksProject — проект с выбранным провайдером видео и одним сохранённым референсом из трёх
// снимков.
func looksProject(t *testing.T, provider string) string {
	t.Helper()
	project := t.TempDir()
	for _, dir := range []string{"plan", "source/heroes"} {
		if err := os.MkdirAll(filepath.Join(project, dir), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	document := `{"name": "Клип", "generation": {"video": {"provider": "` + provider + `", "provider_selected": true}}}`
	manifest := `{"schema_version": 1, "track": null, "lyrics": null, "idea": null, "cover": null, "references": [
		{"id": "hero", "kind": "character", "name": "Герой", "short_name": "Герой", "description": "", "prompt": null, "files": [
			{"path": "heroes/front.png", "sha256": "s1", "bytes": 1, "view": "front", "note": ""},
			{"path": "heroes/side.png", "sha256": "s2", "bytes": 1, "view": "side", "note": ""},
			{"path": "heroes/back.png", "sha256": "s3", "bytes": 1, "view": "back", "note": ""}]}], "updated_at": ""}`
	for path, text := range map[string]string{"plan/project.json": document, "source/manifest.json": manifest} {
		if err := os.WriteFile(filepath.Join(project, path), []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	return project
}

// TestSavedLooksService — путь окна образа на тестовом провайдере: статусы, создание из снимков
// референса, отвязка, привязка готового образа, удаление из аккаунта; проект не меняется.
func TestSavedLooksService(t *testing.T) {
	ctx := context.Background()
	service, err := mediatest.New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Register())
	state := t.TempDir()
	looks := &SavedLooksService{stateDir: func() (string, error) { return state, nil }}
	project := looksProject(t, mediatest.ID)
	before := treeDigest(t, project)

	view, err := looks.View(ctx, project)
	if err != nil || !view.Supported || view.Report == nil || view.Report.States[0].Status != savedlooks.StatusNone || view.Rules.ExtraMax != 2 {
		t.Fatalf("начальный вид %+v %v", view, err)
	}
	if _, err := looks.Create(ctx, project, "hero", SavedLookInput{Name: "Герой", Kind: "character", Cover: "heroes/front.png", Extra: []string{"heroes/elsewhere.png"}}); err == nil || err != errLookFile {
		t.Fatalf("чужой снимок: %v", err)
	}
	if _, err := looks.Create(ctx, project, "nobody", SavedLookInput{Name: "Х", Kind: "character", Cover: "heroes/front.png"}); err != errLookReference {
		t.Fatalf("несохранённый референс: %v", err)
	}
	view, err = looks.Create(ctx, project, "hero", SavedLookInput{Name: "Герой", Description: "Man.", Kind: "character", Cover: "heroes/front.png", Extra: []string{"heroes/side.png"}})
	if err != nil || view.Report.States[0].Status != savedlooks.StatusReady || view.Report.States[0].Look != "look-1" {
		t.Fatalf("после создания %+v %v", view, err)
	}
	created := service.Calls("create_look")
	if len(created) != 1 || created[0].Value("cover") != "front.png" {
		t.Fatalf("создание %v", created)
	}
	if view, err = looks.Unbind(ctx, project, "hero"); err != nil || view.Report.States[0].Status != savedlooks.StatusNone || len(view.Report.Looks) != 1 {
		t.Fatalf("после отвязки %+v %v", view, err)
	}
	if _, err := looks.Bind(ctx, project, "hero", "look-404"); err != errLookNotInAccount {
		t.Fatalf("чужой образ: %v", err)
	}
	if view, err = looks.Bind(ctx, project, "hero", "look-1"); err != nil || view.Report.States[0].Status != savedlooks.StatusReady {
		t.Fatalf("после привязки %+v %v", view, err)
	}
	if view, err = looks.Remove(ctx, project, "look-1"); err != nil || view.Report.States[0].Status != savedlooks.StatusNone || len(view.Report.Looks) != 0 {
		t.Fatalf("после удаления %+v %v", view, err)
	}
	if treeDigest(t, project) != before {
		t.Fatal("действия с образами изменили проект")
	}

	failure := toolrt.NewDict()
	failure.Set("looks_error", "Войдите в тестовый сервис.")
	if err := service.Configure(failure); err != nil {
		t.Fatal(err)
	}
	if view, err = looks.View(ctx, project); err != nil || view.Report != nil || view.Error != "Войдите в тестовый сервис." {
		t.Fatalf("сбой списка %+v %v", view, err)
	}
}

// TestSavedLooksUnsupported — провайдер видео без образов и проект без провайдера: блока нет,
// сеть не трогается.
func TestSavedLooksUnsupported(t *testing.T) {
	looks := &SavedLooksService{stateDir: func() (string, error) { return t.TempDir(), nil }}
	for _, provider := range []string{"codex", ""} {
		view, err := looks.View(context.Background(), looksProject(t, provider))
		if err != nil || view.Supported || view.Report != nil || view.Rules != nil {
			t.Fatalf("%q: %+v %v", provider, view, err)
		}
	}
	if _, err := looks.Unbind(context.Background(), looksProject(t, "codex"), "hero"); err == nil || !strings.Contains(err.Error(), "не хранит") {
		t.Fatalf("действие без поддержки: %v", err)
	}
}

// treeDigest — пути и байты всех файлов папки: проверка, что проект не изменился.
func treeDigest(t *testing.T, dir string) string {
	t.Helper()
	var builder strings.Builder
	err := filepath.Walk(dir, func(path string, info os.FileInfo, err error) error {
		if err != nil || info.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		relative, _ := filepath.Rel(dir, path)
		builder.WriteString(relative + "\x00" + string(data) + "\x00")
		return err
	})
	if err != nil {
		t.Fatal(err)
	}
	return builder.String()
}

// TestSavedLooksShot — герои «В кадре» плана со статусами образов: мир не входит, привязанный
// образ — ready, остальные — none; провайдер без образов — Supported false.
func TestSavedLooksShot(t *testing.T) {
	ctx := context.Background()
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	project := t.TempDir()
	if err := os.CopyFS(project, os.DirFS(filepath.Join(root, "checks-base", "project"))); err != nil {
		t.Fatal(err)
	}
	document := `{"schema_version":1,"name":"Клип","fps":30,"generation":{"video":{"provider":"test","provider_selected":true}}}`
	if err := os.WriteFile(filepath.Join(project, "plan", "project.json"), []byte(document), 0o644); err != nil {
		t.Fatal(err)
	}
	service, err := mediatest.New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(service.Register())
	state := t.TempDir()
	looks := &SavedLooksService{stateDir: func() (string, error) { return state, nil }, models: fixedLookModel{Model: "test-cheap", Limit: 3, Kinds: []string{"character"}}}
	entry := toolrt.NewDict()
	entry.Set("id", "look-9")
	entry.Set("name", "Лодка")
	values := toolrt.NewDict()
	values.Set("saved_looks", []any{entry})
	if err := service.Configure(values); err != nil {
		t.Fatal(err)
	}
	if _, err := looks.Bind(ctx, project, "boat", "look-9"); err != nil {
		t.Fatal(err)
	}
	view, err := looks.Shot(ctx, project, "M01")
	if err != nil || !view.Supported || view.Error != "" || view.Model != "test-cheap" || view.Limit != 3 || len(view.Kinds) != 1 {
		t.Fatalf("вид %+v %v", view, err)
	}
	want := []ShotLook{{Code: "boat", Name: "Лодка", Kind: "vehicle", Status: savedlooks.StatusReady, Look: "look-9", LookName: "Лодка"}, {Code: "pier", Name: "Причал", Kind: "location", Status: savedlooks.StatusNone}}
	if len(view.Heroes) != len(want) || view.Heroes[0] != want[0] || view.Heroes[1] != want[1] {
		t.Fatalf("герои %+v", view.Heroes)
	}
	unsupported := looksProject(t, "none")
	if view, err := looks.Shot(ctx, unsupported, "M01"); err != nil || view.Supported || view.Heroes == nil || len(view.Heroes) != 0 {
		t.Fatalf("без образов %+v %v", view, err)
	}
}

// fixedLookModel — ожидаемая модель плана без прохода производства.
type fixedLookModel productionworkflow.LookModel

func (m fixedLookModel) ExpectedLookModel(context.Context, string) (productionworkflow.LookModel, error) {
	return productionworkflow.LookModel(m), nil
}
