package mediatest

import (
	"context"
	"encoding/json"
	"errors"
	"path/filepath"
	"strconv"
	"strings"
	"time"

	"songframe/internal/mediaapi"
	"songframe/internal/toolrt"
)

// Сохранённые образы тестового сервиса. Модель объявляет образы аргументом looks с max_items
// (в любом виде медиа), библиотека аккаунта — поле saved_looks конфигурации: список
// {id, name, description?, kind?, images?}. Поле looks_error — текст ошибки всех действий
// библиотеки (сбой сервиса). Создание и удаление меняют saved_looks и пишутся в журнал.

// LookArgument — аргумент модели тестового сервиса, объявляющий сохранённые образы.
const LookArgument = "looks"

// lookKinds — виды образов тестового сервиса.
var lookKinds = []string{mediaapi.LookCharacter, mediaapi.LookProp, mediaapi.LookCostume}

// Appearance — модель с аргументом looks принимает сохранённые образы, не больше его max_items.
func (s *Service) Appearance(_, _ string, arguments json.RawMessage) *mediaapi.Appearance {
	var declared map[string]struct {
		MaxItems int `json:"max_items"`
	}
	if json.Unmarshal(arguments, &declared) != nil || declared[LookArgument].MaxItems < 1 {
		return nil
	}
	return &mediaapi.Appearance{Method: mediaapi.AppearanceSaved, MaxItems: declared[LookArgument].MaxItems, Kinds: append([]string(nil), lookKinds...)}
}

// SavedLookRules — имя до 12 символов, 1–2 дополнительных снимка, главный снимок не меняется.
func (s *Service) SavedLookRules() mediaapi.SavedLookRules {
	return mediaapi.SavedLookRules{NameMaxChars: 12, ExtraMin: 1, ExtraMax: 2, Kinds: append([]string(nil), lookKinds...), CoverFixed: true}
}

// libraryError — сбой библиотеки из конфигурации looks_error.
func (s *Service) libraryError() error {
	if message, ok := s.Config().Value("looks_error").(string); ok && message != "" {
		return errors.New(message)
	}
	return nil
}

// library — записи saved_looks конфигурации.
func (s *Service) library() []*toolrt.Dict {
	items, _ := s.Config().Value("saved_looks").([]any)
	entries := []*toolrt.Dict{}
	for _, item := range items {
		if entry, ok := item.(*toolrt.Dict); ok {
			entries = append(entries, entry)
		}
	}
	return entries
}

// saveLibrary записывает saved_looks.
func (s *Service) saveLibrary(entries []*toolrt.Dict) error {
	items := make([]any, len(entries))
	for index, entry := range entries {
		items[index] = entry
	}
	values := toolrt.NewDict()
	values.Set("saved_looks", items)
	return s.Configure(values)
}

// ListSavedLooks — образы saved_looks по порядку.
func (s *Service) ListSavedLooks(context.Context, time.Duration) ([]mediaapi.SavedLook, error) {
	if err := s.journal("list_looks"); err != nil {
		return nil, err
	}
	if err := s.libraryError(); err != nil {
		return nil, err
	}
	looks := []mediaapi.SavedLook{}
	for _, entry := range s.library() {
		id, _ := entry.Value("id").(string)
		name, _ := entry.Value("name").(string)
		looks = append(looks, mediaapi.SavedLook{ID: id, Name: name})
	}
	return looks, nil
}

// GetSavedLook — запись saved_looks по ID; нет такой — ошибка «не найден».
func (s *Service) GetSavedLook(_ context.Context, id string, _ time.Duration) (mediaapi.SavedLookDetails, error) {
	if err := s.journal("get_look", "id", id); err != nil {
		return mediaapi.SavedLookDetails{}, err
	}
	if err := s.libraryError(); err != nil {
		return mediaapi.SavedLookDetails{}, err
	}
	for _, entry := range s.library() {
		if toolrt.Equal(entry.Value("id"), id) {
			details := mediaapi.SavedLookDetails{ID: id}
			details.Name, _ = entry.Value("name").(string)
			details.Description, _ = entry.Value("description").(string)
			details.Kind, _ = entry.Value("kind").(string)
			if images, ok := entry.Value("images").(toolrt.Int); ok {
				count, _ := images.Int64()
				details.Images = int(count)
			}
			return details, nil
		}
	}
	return mediaapi.SavedLookDetails{}, errors.New("Тестовый сервис: образ " + id + " не найден.")
}

// CreateSavedLook — проверка черновика и имени, затем новая запись look-N в saved_looks.
func (s *Service) CreateSavedLook(_ context.Context, draft mediaapi.SavedLookDraft, _ time.Duration) (mediaapi.SavedLook, error) {
	if err := mediaapi.ValidateSavedLookDraft(s.SavedLookRules(), draft); err != nil {
		return mediaapi.SavedLook{}, err
	}
	if err := s.libraryError(); err != nil {
		return mediaapi.SavedLook{}, err
	}
	name := strings.TrimSpace(draft.Name)
	entries := s.library()
	for _, entry := range entries {
		if existing, _ := entry.Value("name").(string); strings.EqualFold(existing, name) {
			return mediaapi.SavedLook{}, errors.New(mediaapi.TextLookNameTaken(name))
		}
	}
	extra := make([]any, len(draft.Extra))
	for index, path := range draft.Extra {
		extra[index] = filepath.Base(path)
	}
	if err := s.journal("create_look", "name", name, "kind", draft.Kind, "cover", filepath.Base(draft.Cover), "extra", extra); err != nil {
		return mediaapi.SavedLook{}, err
	}
	id := "look-" + strconv.Itoa(len(s.Calls("create_look")))
	entry := toolrt.NewDict()
	entry.Set("id", id)
	entry.Set("name", name)
	entry.Set("description", strings.TrimSpace(draft.Description))
	entry.Set("kind", draft.Kind)
	entry.Set("images", toolrt.NewInt(int64(1+len(draft.Extra))))
	if err := s.saveLibrary(append(entries, entry)); err != nil {
		return mediaapi.SavedLook{}, err
	}
	return mediaapi.SavedLook{ID: id, Name: name}, nil
}

// DeleteSavedLook — удаление записи saved_looks; нет такой — ошибка «не найден».
func (s *Service) DeleteSavedLook(_ context.Context, id string, _ time.Duration) error {
	if err := s.journal("delete_look", "id", id); err != nil {
		return err
	}
	if err := s.libraryError(); err != nil {
		return err
	}
	entries := s.library()
	for index, entry := range entries {
		if toolrt.Equal(entry.Value("id"), id) {
			return s.saveLibrary(append(entries[:index], entries[index+1:]...))
		}
	}
	return errors.New("Тестовый сервис: образ " + id + " не найден.")
}

var (
	_ mediaapi.AppearanceDescriber = (*Service)(nil)
	_ mediaapi.SavedLooks          = (*Service)(nil)
)
