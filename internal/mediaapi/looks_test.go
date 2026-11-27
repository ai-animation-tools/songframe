package mediaapi

import "testing"

// TestValidateSavedLookDraft — проверка нового образа по ограничениям провайдера.
func TestValidateSavedLookDraft(t *testing.T) {
	rules := SavedLookRules{NameMaxChars: 5, ExtraMin: 2, ExtraMax: 2, Kinds: []string{LookCharacter}}
	good := SavedLookDraft{Name: " Пётр ", Kind: LookCharacter, Cover: "a.png", Extra: []string{"b.png", "c.png"}}
	if err := ValidateSavedLookDraft(rules, good); err != nil {
		t.Fatal(err)
	}
	cases := map[string]func(*SavedLookDraft){
		"Укажите имя образа.":                           func(d *SavedLookDraft) { d.Name = "  " },
		"Имя образа длиннее 5 символов: сократите его.": func(d *SavedLookDraft) { d.Name = "Пётр I" },
		"Провайдер не хранит образы вида «prop».":       func(d *SavedLookDraft) { d.Kind = LookProp },
		"Выберите главный снимок образа.":               func(d *SavedLookDraft) { d.Cover = "" },
		"Образу нужно дополнительных снимков: 2.":       func(d *SavedLookDraft) { d.Extra = d.Extra[:1] },
	}
	for want, edit := range cases {
		draft := good
		draft.Extra = append([]string(nil), good.Extra...)
		edit(&draft)
		if err := ValidateSavedLookDraft(rules, draft); err == nil || err.Error() != want {
			t.Errorf("ожидалось %q, получено %v", want, err)
		}
	}
}
