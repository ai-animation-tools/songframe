package app

import (
	"context"
	"encoding/json"
	"errors"
	"net/http"
	"os"
	"path/filepath"
	"reflect"
	"testing"

	"songframe-go/internal/media"
	"songframe-go/internal/store"
)

// fakeProfile проверяет поведение сервиса на границе хранения без обращения к профилю пользователя.
type fakeProfile struct {
	path string
	err  error
}

func (p fakeProfile) Directory() (string, error) { return p.path, p.err }

func TestStateKeepsJSONContract(t *testing.T) {
	service := NewAppService(fakeProfile{path: "profile"}, nil, true, nil)
	state, err := service.State()
	if err != nil {
		t.Fatal(err)
	}
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	var value map[string]any
	if err := json.Unmarshal(raw, &value); err != nil {
		t.Fatal(err)
	}
	want := map[string]any{"packaged": true, "problems": []any{}, "toolsRoot": nil, "localDir": "profile", "current": nil, "history": []any{}, "platform": service.platform}
	if !reflect.DeepEqual(value, want) {
		t.Fatalf("JSON-контракт изменился: %s", raw)
	}
}

func TestStateStorageFailureDoesNotReportReady(t *testing.T) {
	calls := 0
	disk := errors.New("диск недоступен")
	service := NewAppService(fakeProfile{err: disk}, nil, true, func(AppState) error { calls++; return nil })
	if _, err := service.State(); !errors.Is(err, disk) {
		t.Fatalf("потеряна исходная ошибка: %v", err)
	}
	if err := service.FrontendReady(); err == nil {
		t.Fatal("ошибка State принята за готовность")
	}
	if calls != 0 {
		t.Fatal("callback готовности вызван после ошибки")
	}
}

func TestFrontendReadyReceivesSuccessfulState(t *testing.T) {
	var received *AppState
	service := NewAppService(fakeProfile{path: "profile"}, nil, false, func(state AppState) error { received = &state; return nil })
	if err := service.FrontendReady(); err == nil {
		t.Fatal("готовность разрешена без State")
	}
	if _, err := service.State(); err != nil {
		t.Fatal(err)
	}
	if err := service.FrontendReady(); err != nil {
		t.Fatal(err)
	}
	if received == nil || received.LocalDir != "profile" || received.Packaged {
		t.Fatalf("неверный снимок: %#v", received)
	}
}

// TestStateAllowsCurrentProjectMedia — проект прошлого сеанса renderer показывает без projects.open,
// поэтому app.state сам разрешает его корень на медиасервере; пропавшая папка не разрешается.
func TestStateAllowsCurrentProjectMedia(t *testing.T) {
	profile := t.TempDir()
	project := filepath.Join(t.TempDir(), "Огород")
	if err := os.Mkdir(project, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := store.NewLocalState(profile).WriteCurrent(project); err != nil {
		t.Fatal(err)
	}
	media := &registrySpy{}
	state, err := NewAppService(fakeProfile{path: profile}, media, true, nil).State()
	if err != nil {
		t.Fatal(err)
	}
	if state.Current == nil || *state.Current != project || !reflect.DeepEqual(media.roots, []string{project}) {
		t.Fatalf("current=%v roots=%v", state.Current, media.roots)
	}

	if err := os.Remove(project); err != nil {
		t.Fatal(err)
	}
	media.roots = nil
	if state, err = NewAppService(fakeProfile{path: profile}, media, true, nil).State(); err != nil || state.Current != nil || len(media.roots) != 0 {
		t.Fatalf("пропавший проект: current=%v roots=%v err=%v", state.Current, media.roots, err)
	}
}

// TestStateServesCurrentProjectFiles — та же граница на настоящем медиасервере: до app.state файл
// проекта прошлого сеанса отклоняется, после — отдаётся по shell.fileUrl (трек, обложка, референсы).
func TestStateServesCurrentProjectFiles(t *testing.T) {
	server, err := media.Start()
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { _ = server.Close(context.Background()) })
	profile := t.TempDir()
	project := filepath.Join(t.TempDir(), "Клип с пробелом")
	track := filepath.Join(project, "source", "трек.mp3")
	if err := os.MkdirAll(filepath.Dir(track), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(track, []byte("ID3"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := store.NewLocalState(profile).WriteCurrent(project); err != nil {
		t.Fatal(err)
	}
	get := func() int {
		response, err := http.Get(media.FileURL(server.BaseURL(), track))
		if err != nil {
			t.Fatal(err)
		}
		response.Body.Close()
		return response.StatusCode
	}
	if code := get(); code == http.StatusOK {
		t.Fatalf("файл вне разрешённых корней отдан до app.state")
	}
	if _, err := NewAppService(fakeProfile{path: profile}, server, true, nil).State(); err != nil {
		t.Fatal(err)
	}
	if code := get(); code != http.StatusOK {
		t.Fatalf("после app.state код %d", code)
	}
}
