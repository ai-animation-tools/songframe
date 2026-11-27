package mediatest

import (
	"context"
	"encoding/json"
	"strings"
	"testing"

	"songframe/internal/mediaapi"
	"songframe/internal/toolrt"
)

// TestSavedLooks — библиотека образов тестового сервиса: создание, занятое имя, список, просмотр,
// удаление, сбой сервиса и журнал действий.
func TestSavedLooks(t *testing.T) {
	ctx := context.Background()
	service, err := New(t.TempDir(), nil)
	if err != nil {
		t.Fatal(err)
	}
	draft := mediaapi.SavedLookDraft{Name: "Герой", Kind: mediaapi.LookCharacter, Cover: "/x/front.png", Extra: []string{"/x/side.png"}}
	look, err := service.CreateSavedLook(ctx, draft, 0)
	if err != nil || look != (mediaapi.SavedLook{ID: "look-1", Name: "Герой"}) {
		t.Fatalf("создание %+v %v", look, err)
	}
	if _, err := service.CreateSavedLook(ctx, draft, 0); err == nil || err.Error() != mediaapi.TextLookNameTaken("Герой") {
		t.Fatalf("занятое имя: %v", err)
	}
	draft.Name, draft.Kind = "Плащ", mediaapi.LookCostume
	if _, err := service.CreateSavedLook(ctx, draft, 0); err != nil {
		t.Fatal(err)
	}
	looks, err := service.ListSavedLooks(ctx, 0)
	if err != nil || len(looks) != 2 || looks[1] != (mediaapi.SavedLook{ID: "look-2", Name: "Плащ"}) {
		t.Fatalf("список %+v %v", looks, err)
	}
	details, err := service.GetSavedLook(ctx, "look-2", 0)
	if err != nil || details.Kind != mediaapi.LookCostume || details.Images != 2 {
		t.Fatalf("образ %+v %v", details, err)
	}
	if err := service.DeleteSavedLook(ctx, "look-1", 0); err != nil {
		t.Fatal(err)
	}
	if err := service.DeleteSavedLook(ctx, "look-1", 0); err == nil || !strings.Contains(err.Error(), "не найден") {
		t.Fatalf("повторное удаление: %v", err)
	}
	if looks, _ := service.ListSavedLooks(ctx, 0); len(looks) != 1 || looks[0].ID != "look-2" {
		t.Fatalf("после удаления %+v", looks)
	}
	created := service.Calls("create_look")
	if len(created) != 2 || created[0].Value("cover") != "front.png" {
		t.Fatalf("журнал создания %v", created)
	}
	failure := toolrt.NewDict()
	failure.Set("looks_error", "Тестовый сервис недоступен.")
	if err := service.Configure(failure); err != nil {
		t.Fatal(err)
	}
	if _, err := service.ListSavedLooks(ctx, 0); err == nil || err.Error() != "Тестовый сервис недоступен." {
		t.Fatalf("сбой: %v", err)
	}
}

// TestAppearance — образы объявляет аргумент looks с пределом.
func TestAppearance(t *testing.T) {
	service := &Service{}
	if got := service.Appearance("video", "image_to_video", json.RawMessage(`{"looks": {"max_items": 2}}`)); got == nil || got.Method != mediaapi.AppearanceSaved || got.MaxItems != 2 {
		t.Fatalf("с образами %+v", got)
	}
	if got := service.Appearance("video", "image_to_video", json.RawMessage(`{"duration": {}}`)); got != nil {
		t.Fatalf("без образов %+v", got)
	}
}
