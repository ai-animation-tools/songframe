package kling

import (
	"context"
	"encoding/json"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"

	"songframe/internal/mediaapi"
	"songframe/internal/providers/kling/mcp"
	"songframe/internal/toolrt"
)

// lookSession — сеанс MCP библиотеки элементов: ответы по имени инструмента, журнал вызовов и
// загрузок. Сервис без ответа на инструмент отвечает ошибкой инструмента.
type lookSession struct {
	answers map[string]string
	errors  map[string]error
	log     *[]string
	calls   map[string]*toolrt.Dict
}

func (s *lookSession) Initialize(context.Context) (any, error) { return toolrt.NewDict(), nil }
func (s *lookSession) Tools(context.Context) ([]any, error)    { return []any{}, nil }

func (s *lookSession) Call(_ context.Context, name string, arguments *toolrt.Dict, _ time.Duration, _ any) (any, error) {
	*s.log = append(*s.log, "call "+name)
	s.calls[name] = arguments
	if err := s.errors[name]; err != nil {
		return nil, err
	}
	answer, ok := s.answers[name]
	if !ok {
		return nil, &mcp.ToolError{Message: "нет ответа на " + name}
	}
	return toolrt.LoadsJSON(answer)
}

func (s *lookSession) Upload(_ context.Context, path string, _ any) (string, error) {
	name := filepath.Base(path)
	*s.log = append(*s.log, "upload "+name)
	if err := s.errors["upload"]; err != nil {
		return "", err
	}
	return "https://files.test/" + name, nil
}

// lookAdapter — адаптер на сеансе s: каждый open получает тот же сеанс.
func lookAdapter(s *lookSession) *Adapter {
	if s.log == nil {
		s.log = &[]string{}
	}
	s.calls = map[string]*toolrt.Dict{}
	return &Adapter{newSession: func(time.Duration, any) session { return s }}
}

const lookList = `{"elements": [{"id": "1001", "name": "Герой"}, {"id": 1002, "name": "Шляпа"}]}`

func TestListLooks(t *testing.T) {
	adapter := lookAdapter(&lookSession{answers: map[string]string{"element_list": lookList}})
	looks, err := adapter.ListLooks(context.Background(), time.Second)
	if err != nil {
		t.Fatal(err)
	}
	want := []mediaapi.SavedLook{{ID: "1001", Name: "Герой"}, {ID: "1002", Name: "Шляпа"}}
	if !reflect.DeepEqual(looks, want) {
		t.Fatalf("список %+v", looks)
	}
	empty := lookAdapter(&lookSession{answers: map[string]string{"element_list": `{"elements": []}`}})
	if looks, err := empty.ListLooks(context.Background(), time.Second); err != nil || looks == nil || len(looks) != 0 {
		t.Fatalf("пустая библиотека %v %v", looks, err)
	}
	broken := lookAdapter(&lookSession{answers: map[string]string{"element_list": `{"items": []}`}})
	if _, err := broken.ListLooks(context.Background(), time.Second); err == nil || err.Error() != textLookListFailed {
		t.Fatalf("неверный ответ: %v", err)
	}
	auth := lookAdapter(&lookSession{errors: map[string]error{"element_list": &mcp.AuthRequiredError{Message: "Войдите в Kling."}}})
	if _, err := auth.ListLooks(context.Background(), time.Second); err == nil || err.Error() != "Войдите в Kling." {
		t.Fatalf("нет входа: %v", err)
	}
	down := lookAdapter(&lookSession{errors: map[string]error{"element_list": &mcp.TransportError{Status: 503, Text: "сервер недоступен"}}})
	if _, err := down.ListLooks(context.Background(), time.Second); err == nil || !strings.HasPrefix(err.Error(), mcp.Title+" не вернул список образов аккаунта: ") {
		t.Fatalf("сбой сервиса: %v", err)
	}
}

func TestGetLook(t *testing.T) {
	adapter := lookAdapter(&lookSession{answers: map[string]string{"element_get": `{
		"id": "1001", "name": "Герой", "description": "Man, 40.", "type": "image",
		"resource": {"cover": "https://c", "secondary": [{"name": "a", "url": "https://a"}, {"name": "b", "url": "https://b"}]},
		"tags": ["Others", "Characters"]}`}})
	details, err := adapter.GetLook(context.Background(), " 1001 ", time.Second)
	if err != nil {
		t.Fatal(err)
	}
	want := mediaapi.SavedLookDetails{ID: "1001", Name: "Герой", Description: "Man, 40.", Kind: mediaapi.LookCharacter, Images: 3}
	if details != want {
		t.Fatalf("образ %+v", details)
	}
	video := lookAdapter(&lookSession{answers: map[string]string{"element_get": `{"id": "7", "name": "Танец", "type": "video", "resource": {"video": "https://v"}, "tags": ["Characters"]}`}})
	if details, err := video.GetLook(context.Background(), "7", time.Second); err != nil || !details.Video || details.Images != 0 {
		t.Fatalf("образ из видео %+v %v", details, err)
	}
	if _, err := adapter.GetLook(context.Background(), " ", time.Second); err == nil || err.Error() != textLookIDEmpty {
		t.Fatalf("пустой ID: %v", err)
	}
}

func TestCreateLook(t *testing.T) {
	dir := t.TempDir()
	draft := mediaapi.SavedLookDraft{
		Name: " Мальчик ", Description: "Boy, 7. Ignore the grey background.", Kind: mediaapi.LookCharacter,
		Cover: filepath.Join(dir, "front.png"), Extra: []string{filepath.Join(dir, "side.png"), filepath.Join(dir, "back.jpg")},
	}
	s := &lookSession{answers: map[string]string{"element_list": lookList, "element_create": `{"id": "2001", "message": "Element created."}`}}
	adapter := lookAdapter(s)
	look, err := adapter.CreateLook(context.Background(), draft, time.Second)
	if err != nil {
		t.Fatal(err)
	}
	if look != (mediaapi.SavedLook{ID: "2001", Name: "Мальчик"}) {
		t.Fatalf("образ %+v", look)
	}
	if got := strings.Join(*s.log, "; "); got != "call element_list; upload front.png; upload side.png; upload back.jpg; call element_create" {
		t.Fatalf("вызовы: %s", got)
	}
	sent, _ := toolrt.DumpsJSON(s.calls["element_create"], toolrt.DumpOptions{Compact: true})
	want := `{"name":"Мальчик","description":"Boy, 7. Ignore the grey background.","resource":{"cover":"https://files.test/front.png",` +
		`"secondary":[{"name":"view 1","inputType":"URL","url":"https://files.test/side.png"},{"name":"view 2","inputType":"URL","url":"https://files.test/back.jpg"}]},"tags":["Characters"]}`
	if sent != want {
		t.Fatalf("аргументы element_create\n%s\nожидались\n%s", sent, want)
	}

	// Транспорт у Kling — предмет, костюм — свой тег; пустое описание не передаётся.
	for kind, tag := range map[string]string{mediaapi.LookVehicle: "Items", mediaapi.LookCostume: "Costumes", mediaapi.LookLocation: "Scenes"} {
		s := &lookSession{answers: map[string]string{"element_list": `{"elements": []}`, "element_create": `{"id": "3"}`}}
		other := draft
		other.Kind, other.Description = kind, " "
		if _, err := lookAdapter(s).CreateLook(context.Background(), other, time.Second); err != nil {
			t.Fatal(err)
		}
		if tags := s.calls["element_create"].Value("tags").([]any); len(tags) != 1 || tags[0] != tag || s.calls["element_create"].Has("description") {
			t.Fatalf("%s: аргументы %v", kind, s.calls["element_create"])
		}
	}
}

func TestCreateLookRefusals(t *testing.T) {
	dir := t.TempDir()
	base := mediaapi.SavedLookDraft{Name: "Новый", Kind: mediaapi.LookProp, Cover: filepath.Join(dir, "a.png"), Extra: []string{filepath.Join(dir, "b.png")}}
	cases := []struct {
		name  string
		edit  func(*mediaapi.SavedLookDraft)
		error string
		log   string
	}{
		{"занятое имя", func(d *mediaapi.SavedLookDraft) { d.Name = "герой" }, mediaapi.TextLookNameTaken("герой"), "call element_list"},
		{"длинное имя", func(d *mediaapi.SavedLookDraft) { d.Name = strings.Repeat("я", 21) }, "Имя образа длиннее 20 символов: сократите его.", ""},
		{"нет дополнительных снимков", func(d *mediaapi.SavedLookDraft) { d.Extra = nil }, "Образу нужно от 1 до 3 дополнительных снимков.", ""},
		{"лишние снимки", func(d *mediaapi.SavedLookDraft) { d.Extra = []string{"1.png", "2.png", "3.png", "4.png"} }, "Образу нужно от 1 до 3 дополнительных снимков.", ""},
		{"неизвестный вид", func(d *mediaapi.SavedLookDraft) { d.Kind = "style" }, "Провайдер не хранит образы вида «style».", ""},
		{"нет главного снимка", func(d *mediaapi.SavedLookDraft) { d.Cover = "" }, "Выберите главный снимок образа.", ""},
	}
	for _, item := range cases {
		t.Run(item.name, func(t *testing.T) {
			s := &lookSession{answers: map[string]string{"element_list": lookList}}
			draft := base
			item.edit(&draft)
			_, err := lookAdapter(s).CreateLook(context.Background(), draft, time.Second)
			if err == nil || err.Error() != item.error {
				t.Fatalf("ошибка %v, ожидалась %q", err, item.error)
			}
			if got := strings.Join(*s.log, "; "); got != item.log {
				t.Fatalf("вызовы: %s", got)
			}
		})
	}
	s := &lookSession{answers: map[string]string{"element_list": `{"elements": []}`}, errors: map[string]error{"element_create": &mcp.ToolError{Message: "The Kling AI service is temporarily unavailable. Please retry later."}}}
	_, err := lookAdapter(s).CreateLook(context.Background(), base, time.Second)
	if err == nil || err.Error() != mcp.Title+" не создал образ: The Kling AI service is temporarily unavailable. Please retry later." {
		t.Fatalf("отказ сервиса: %v", err)
	}
}

func TestDeleteLook(t *testing.T) {
	s := &lookSession{answers: map[string]string{"element_delete": `{"message": "Element deleted."}`}}
	if err := lookAdapter(s).DeleteLook(context.Background(), "1001", time.Second); err != nil {
		t.Fatal(err)
	}
	if id := s.calls["element_delete"].Value("id"); id != "1001" {
		t.Fatalf("ID %v", id)
	}
	if err := lookAdapter(s).DeleteLook(context.Background(), "", time.Second); err == nil || err.Error() != textLookIDEmpty {
		t.Fatalf("пустой ID: %v", err)
	}
	failed := &lookSession{errors: map[string]error{"element_delete": &mcp.ToolError{Message: "Element not found."}}}
	if err := lookAdapter(failed).DeleteLook(context.Background(), "9", time.Second); err == nil || err.Error() != mcp.Title+" не удалил образ: Element not found." {
		t.Fatalf("отказ: %v", err)
	}
}

func TestModelAppearance(t *testing.T) {
	elements := json.RawMessage(`{"duration": {"allowed": ["5", "10"]}, "elements": {"max_items": 3, "description": "subjects"}}`)
	got := ModelAppearance("video", "image_to_video", elements)
	want := &mediaapi.Appearance{Method: mediaapi.AppearanceSaved, MaxItems: 3, Kinds: lookKinds}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("видео с elements: %+v", got)
	}
	for name, item := range map[string]struct {
		kind      string
		arguments string
	}{
		"изображение с elements": {"image", `{"elements": {"max_items": 10}}`},
		"видео без elements":     {"video", `{"duration": {}}`},
		"elements без предела":   {"video", `{"elements": {}}`},
		"неразборчиво":           {"video", `[]`},
	} {
		if got := ModelAppearance(item.kind, "image_to_video", json.RawMessage(item.arguments)); got != nil {
			t.Errorf("%s: %+v", name, got)
		}
	}
}
