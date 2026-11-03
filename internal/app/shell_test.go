package app

import (
	"encoding/json"
	"errors"
	"reflect"
	"testing"
)

// fakeProfile проверяет поведение сервиса на границе хранения без обращения к профилю пользователя.
type fakeProfile struct {
	path string
	err  error
}

func (p fakeProfile) Directory() (string, error) { return p.path, p.err }

func TestStateKeepsJSONContract(t *testing.T) {
	service := NewShellService(fakeProfile{path: "profile"}, true, nil)
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
	service := NewShellService(fakeProfile{err: disk}, true, func(AppState) error { calls++; return nil })
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
	service := NewShellService(fakeProfile{path: "profile"}, false, func(state AppState) error { received = &state; return nil })
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
