package savedlooks

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"io/fs"
	"os"
	"path/filepath"
	"reflect"
	"sort"
	"strings"
	"testing"

	"songframe/internal/mediaapi"
	"songframe/internal/mediatest"
	"songframe/internal/toolrt"
)

// writeManifest — опись проекта с референсами «id → SHA снимков».
func writeManifest(t *testing.T, project string, references map[string][]string) {
	t.Helper()
	ids := make([]string, 0, len(references))
	for id := range references {
		ids = append(ids, id)
	}
	sort.Strings(ids)
	items := []string{}
	for _, id := range ids {
		files := []string{}
		for index, sha := range references[id] {
			files = append(files, `{"path": "heroes/`+id+string(rune('a'+index))+`.png", "sha256": "`+sha+`", "bytes": 1, "view": "front", "note": ""}`)
		}
		items = append(items, `{"id": "`+id+`", "kind": "character", "name": "`+id+`", "short_name": "`+id+`", "description": "", "files": [`+strings.Join(files, ", ")+`], "prompt": null}`)
	}
	text := `{"schema_version": 1, "track": null, "lyrics": null, "idea": null, "cover": null, "references": [` + strings.Join(items, ", ") + `], "updated_at": ""}`
	if err := os.MkdirAll(filepath.Join(project, "source"), 0o777); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(project, "source", "manifest.json"), []byte(text), 0o666); err != nil {
		t.Fatal(err)
	}
}

// treeHash — SHA-256 всех файлов папки с путями: проверка, что проект не изменился.
func treeHash(t *testing.T, dir string) string {
	t.Helper()
	hash := sha256.New()
	err := filepath.WalkDir(dir, func(path string, entry fs.DirEntry, err error) error {
		if err != nil || entry.IsDir() {
			return err
		}
		data, err := os.ReadFile(path)
		if err != nil {
			return err
		}
		relative, _ := filepath.Rel(dir, path)
		hash.Write([]byte(relative + "\x00"))
		hash.Write(data)
		return nil
	})
	if err != nil {
		t.Fatal(err)
	}
	return hex.EncodeToString(hash.Sum(nil))
}

func TestBindings(t *testing.T) {
	store := Store{Dir: t.TempDir()}
	project := filepath.Join(t.TempDir(), "клип")
	bind := func(account, reference, look string) {
		t.Helper()
		if err := store.Bind("Test", Binding{Account: account, Project: project, Reference: reference, Look: look, Name: look, Images: []string{"a", "a", "b"}}); err != nil {
			t.Fatal(err)
		}
	}
	bind("acc-1", "hero", "look-1")
	bind("acc-2", "hero", "look-9")
	bind("acc-1", "hero", "look-2") // замена прежней привязки того же референса
	bind("acc-1", "cup", "look-3")
	got, err := store.Bindings("test", "acc-1", project+string(filepath.Separator))
	if err != nil {
		t.Fatal(err)
	}
	if len(got) != 2 || got[0].Reference != "hero" || got[0].Look != "look-2" || !reflect.DeepEqual(got[0].Images, []string{"a", "b"}) || got[1].Look != "look-3" {
		t.Fatalf("привязки acc-1: %+v", got)
	}
	if other, _ := store.Bindings("test", "acc-2", project); len(other) != 1 || other[0].Look != "look-9" {
		t.Fatalf("привязки acc-2: %+v", other)
	}
	if err := store.Unbind("test", "acc-1", project, "cup"); err != nil {
		t.Fatal(err)
	}
	if err := store.ForgetLook("test", "acc-1", "look-2"); err != nil {
		t.Fatal(err)
	}
	if left, _ := store.Bindings("test", "acc-1", project); len(left) != 0 {
		t.Fatalf("после отвязки: %+v", left)
	}
	if left, _ := store.Bindings("test", "acc-2", project); len(left) != 1 {
		t.Fatalf("чужой аккаунт затронут: %+v", left)
	}
	if err := store.Bind("test", Binding{Account: "acc-1", Project: project, Reference: "hero"}); err == nil {
		t.Fatal("привязка без образа принята")
	}
	path := filepath.Join(store.Dir, "providers", "test", "saved-looks.json")
	if err := os.WriteFile(path, []byte("{"), 0o666); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Bindings("test", "acc-1", project); err == nil || !strings.Contains(err.Error(), "повреждён") {
		t.Fatalf("повреждённый файл: %v", err)
	}
}

func TestStatuses(t *testing.T) {
	references := []Reference{
		{ID: "hero", Images: []string{"h1", "h2"}},
		{ID: "cup", Images: []string{"c2"}},
		{ID: "gone", Images: []string{"g1"}},
		{ID: "plain", Images: []string{"p1"}},
		{ID: "elsewhere", Images: []string{"e1"}},
	}
	bindings := []Binding{
		{Account: "acc", Reference: "hero", Look: "1", Name: "Герой", Images: []string{"h1"}},
		{Account: "acc", Reference: "cup", Look: "2", Name: "Чашка", Images: []string{"c1"}},
		{Account: "acc", Reference: "gone", Look: "3", Name: "Ушедший", Images: []string{"g1"}},
		{Account: "other", Reference: "elsewhere", Look: "4", Images: []string{"e1"}},
	}
	library := mediaapi.SavedLookLibrary{Account: "acc", Looks: []mediaapi.SavedLook{{ID: "1", Name: "Герой (переименован)"}, {ID: "2", Name: "Чашка"}, {ID: "8", Name: "Чужой"}}}
	report := Statuses(bindings, library, references)
	want := []State{
		{Reference: "hero", Status: StatusReady, Look: "1", Name: "Герой (переименован)"},
		{Reference: "cup", Status: StatusStale, Look: "2", Name: "Чашка"},
		{Reference: "gone", Status: StatusMissing, Look: "3", Name: "Ушедший"},
		{Reference: "plain", Status: StatusNone},
		{Reference: "elsewhere", Status: StatusNone},
	}
	if !reflect.DeepEqual(report.States, want) || report.Count != 3 || report.Account != "acc" {
		t.Fatalf("статусы %+v", report)
	}
}

// TestCheck — статусы проекта на тестовом провайдере: создан, устарел после смены снимков,
// не найден после удаления в аккаунте, другой аккаунт; проект при этом не меняется.
func TestCheck(t *testing.T) {
	ctx := context.Background()
	service, err := mediatest.New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	store := Store{Dir: t.TempDir()}
	project := t.TempDir()
	writeManifest(t, project, map[string][]string{"hero": {"h1", "h2"}, "cup": {"c1"}})
	before := treeHash(t, project)

	look, err := service.CreateSavedLook(ctx, mediaapi.SavedLookDraft{Name: "Герой", Kind: mediaapi.LookCharacter, Cover: "h1.png", Extra: []string{"h2.png"}}, 0)
	if err != nil {
		t.Fatal(err)
	}
	if err := store.Bind(mediatest.ID, Binding{Account: mediatest.DefaultAccount, Project: project, Reference: "hero", Look: look.ID, Name: look.Name, Images: []string{"h1", "h2"}, Created: true}); err != nil {
		t.Fatal(err)
	}
	status := func() map[string]string {
		t.Helper()
		report, err := store.Check(ctx, service, mediatest.ID, project, 0)
		if err != nil {
			t.Fatal(err)
		}
		result := map[string]string{}
		for _, state := range report.States {
			result[state.Reference] = state.Status
		}
		return result
	}
	if got := status(); got["hero"] != StatusReady || got["cup"] != StatusNone {
		t.Fatalf("после создания %v", got)
	}
	if treeHash(t, project) != before {
		t.Fatal("проверка статусов изменила проект")
	}
	writeManifest(t, project, map[string][]string{"hero": {"h1", "h3"}, "cup": {"c1"}})
	if got := status(); got["hero"] != StatusStale {
		t.Fatalf("после смены снимка %v", got)
	}
	if err := service.DeleteSavedLook(ctx, look.ID, 0); err != nil {
		t.Fatal(err)
	}
	if got := status(); got["hero"] != StatusMissing {
		t.Fatalf("после удаления в аккаунте %v", got)
	}
	account := toolrt.NewDict()
	account.Set("account", "second")
	if err := service.Configure(account); err != nil {
		t.Fatal(err)
	}
	if got := status(); got["hero"] != StatusNone {
		t.Fatalf("в другом аккаунте %v", got)
	}
	if len(service.Calls("list_looks")) != 4 {
		t.Fatalf("на каждую проверку — один список: %d", len(service.Calls("list_looks")))
	}
	failure := toolrt.NewDict()
	failure.Set("looks_error", "Сервис недоступен.")
	if err := service.Configure(failure); err != nil {
		t.Fatal(err)
	}
	if _, err := store.Check(ctx, service, mediatest.ID, project, 0); err == nil || err.Error() != "Сервис недоступен." {
		t.Fatalf("сбой списка: %v", err)
	}
}
