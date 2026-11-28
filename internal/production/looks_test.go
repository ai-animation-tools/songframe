package production_test

import (
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"

	"songframe/internal/mediaadapters"
	"songframe/internal/mediatest"
	"songframe/internal/production"
	"songframe/internal/savedlooks"
)

// boatLook — замороженный запрос с образом look-3 у сущности boat.
const boatLook = `, "saved_looks": [{"code": "boat", "entity": "Лодка", "look": "look-3", "name": "Лодка"}]`

// looksEnv — окружение с запросом boatLook и каталогом состояния во временной папке; library —
// образы аккаунта тестового сервиса (id → имя), bound — образ, привязанный к референсу boat
// ("" — без привязки).
func looksEnv(t *testing.T, library map[string]string, bound string) (*env, savedlooks.Store) {
	t.Helper()
	e := newEnvSpec(t, "test-video", boatLook)
	state := t.TempDir()
	saved := mediaadapters.StateDir
	mediaadapters.StateDir = func() (string, error) { return state, nil }
	t.Cleanup(func() { mediaadapters.StateDir = saved })
	store := savedlooks.Store{Dir: state}
	setLibrary(t, e, library)
	if bound != "" {
		references, err := savedlooks.References(e.project)
		if err != nil {
			t.Fatal(err)
		}
		images := []string{}
		for _, item := range references {
			if item.ID == "boat" {
				images = item.Images
			}
		}
		if err := store.Bind(mediatest.ID, savedlooks.Binding{
			Account: mediatest.DefaultAccount, Project: savedlooks.ProjectKey(e.project), Reference: "boat", Look: bound, Name: library[bound], Images: images,
		}); err != nil {
			t.Fatal(err)
		}
	}
	return e, store
}

// setLibrary заменяет библиотеку образов тестового сервиса, сохраняя остальную конфигурацию.
func setLibrary(t *testing.T, e *env, library map[string]string) {
	t.Helper()
	entries := []string{}
	for id, name := range library {
		entries = append(entries, `{"id": "`+id+`", "name": "`+name+`"}`)
	}
	configure(t, e.service, `{"balance": 1000, "results": {"video": "video.mp4"}, "saved_looks": [`+strings.Join(entries, ", ")+`]}`)
}

// Оценка сверяет образы запроса с аккаунтом: всё на месте — список пуст и отправка идёт;
// у референса другой образ — предупреждение changed, отправка разрешена.
func TestQuoteSavedLooks(t *testing.T) {
	e, _ := looksEnv(t, map[string]string{"look-3": "Лодка"}, "look-3")
	quote := e.quote()
	if len(quote.Looks) != 0 {
		t.Fatalf("образы в порядке, а проверки %+v", quote.Looks)
	}
	if calls := e.service.Calls("list_looks"); len(calls) != 1 {
		t.Fatalf("списков образов при оценке: %d", len(calls))
	}
	submitted(t, e, quote)
	if e.paid() != 1 {
		t.Fatalf("отправок: %d", e.paid())
	}

	e, _ = looksEnv(t, map[string]string{"look-3": "Лодка", "look-4": "Лодка 2"}, "look-4")
	quote = e.quote()
	want := []savedlooks.UseCheck{{Code: "boat", Entity: "Лодка", Name: "Лодка", Status: savedlooks.UseChanged}}
	if !reflect.DeepEqual(quote.Looks, want) {
		t.Fatalf("проверки %+v, нужно %+v", quote.Looks, want)
	}
	submitted(t, e, quote)
	if e.paid() != 1 {
		t.Fatalf("предупреждение не блокирует отправку: отправок %d", e.paid())
	}
}

// Образа нет в аккаунте — оценка говорит missing, отправка отклонена без оплаты; образ удалён
// после оценки — отправка тоже отклонена.
func TestSubmitBlockedByMissingLook(t *testing.T) {
	e, _ := looksEnv(t, map[string]string{"look-9": "Другой"}, "")
	quote := e.quote()
	if len(quote.Looks) != 1 || quote.Looks[0].Status != savedlooks.UseMissing {
		t.Fatalf("проверки %+v", quote.Looks)
	}
	if _, err := e.submit(quote, ""); err == nil || !strings.Contains(err.Error(), "Образов запроса больше нет в аккаунте провайдера видео (Лодка)") {
		t.Fatalf("отправка без образа: %v", err)
	}

	e, _ = looksEnv(t, map[string]string{"look-3": "Лодка"}, "look-3")
	quote = e.quote()
	setLibrary(t, e, map[string]string{})
	if _, err := e.submit(quote, ""); err == nil || !strings.Contains(err.Error(), "Образов запроса больше нет") {
		t.Fatalf("образ удалён после оценки: %v", err)
	}
	if e.paid() != 0 {
		t.Fatalf("оплата без образа: %d", e.paid())
	}
}

// Сбой списка аккаунта не даёт ни оценки, ни отправки запроса с образами: наличие образов не
// проверено. Запрос без образов к аккаунту не обращается ни при оценке, ни при отправке.
func TestQuoteLooksListFailure(t *testing.T) {
	e, _ := looksEnv(t, map[string]string{"look-3": "Лодка"}, "look-3")
	quote := e.quote()
	configure(t, e.service, `{"balance": 1000, "results": {"video": "video.mp4"}, "looks_error": "нет связи"}`)
	view := e.view()
	if _, err := e.prod.Quote(e.project, e.pkg, *view.Request.SHA256, view.DecisionToken); err == nil || !strings.Contains(err.Error(), "Не удалось проверить сохранённые образы запроса") {
		t.Fatalf("оценка при сбое списка: %v", err)
	}
	if _, err := e.submit(quote, ""); err == nil || !strings.Contains(err.Error(), "Не удалось проверить сохранённые образы запроса") {
		t.Fatalf("отправка при сбое списка: %v", err)
	}
	if e.paid() != 0 {
		t.Fatalf("оплата без проверки образов: %d", e.paid())
	}

	plain := newEnv(t, "test-video")
	submitted(t, plain, plain.quote())
	if calls := plain.service.Calls("list_looks"); len(calls) != 0 || plain.paid() != 1 {
		t.Fatalf("запрос без образов: списков %d, отправок %d", len(calls), plain.paid())
	}
}

// Метки видеопромпта попытки, чьих образов запрос не несёт, — герои, потерявшие облик; у
// запроса с образом героя его метка не считается потерянной.
func TestPackageLostLooks(t *testing.T) {
	e := newEnv(t, "test-video")
	prompt := filepath.Join(e.pkg, "video-prompt.txt")
	if err := os.WriteFile(prompt, []byte("Лодка [@boat] у причала [@pier]; лодка [@boat] стоит."), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := e.view().Request.LostLooks; !reflect.DeepEqual(got, []string{"Лодка", "Причал"}) {
		t.Fatalf("потерянные образы: %v", got)
	}
	if err := os.WriteFile(prompt, []byte("Лодка стоит."), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := e.view().Request.LostLooks; got != nil {
		t.Fatalf("без меток: %v", got)
	}

	e = newEnvSpec(t, "test-video", boatLook)
	if err := os.WriteFile(filepath.Join(e.pkg, "video-prompt.txt"), []byte("Лодка [@boat] у причала [@pier]."), 0o644); err != nil {
		t.Fatal(err)
	}
	if got := e.view().Request.LostLooks; !reflect.DeepEqual(got, []string{"Причал"}) {
		t.Fatalf("потерянные образы при образе лодки: %v", got)
	}
}

// submitted отправляет оценку quote и дожидается задания.
func submitted(t *testing.T, e *env, quote production.Quote) {
	t.Helper()
	info, err := e.submit(quote, "")
	if err != nil {
		t.Fatal(err)
	}
	e.wait(info)
}
