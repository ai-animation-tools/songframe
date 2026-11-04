package resources

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// TestFonts проверяет, что встроенные шрифты и лицензия совпадают байт в байт с файлами
// tools/render_animatic_cards/fonts оригинала на 634fd94: от них зависят ширины строк карточек.
func TestFonts(t *testing.T) {
	want := map[string]string{
		FontDejaVuSans:     "ae7b7855e115a5966d8b1b3f80f254ccc117ec86f9965e202ee2940453837280",
		FontDejaVuSansBold: "5c1247acef7f2b8522a31742c76d6adcb5569bacc0be7ceaa4dc39dd252ce895",
		"LICENSE":          "42c838f0d8f487146df24ffbdd155409c031c40769df8a557ae61623496938f5",
	}
	for name, digest := range want {
		data, err := Font(name)
		if err != nil {
			t.Fatalf("%s: %v", name, err)
		}
		sum := sha256.Sum256(data)
		if got := hex.EncodeToString(sum[:]); got != digest {
			t.Errorf("%s: SHA-256 %s, ожидался %s", name, got, digest)
		}
	}
	if _, err := Font("missing.ttf"); err == nil {
		t.Error("неизвестный шрифт должен давать ошибку")
	}
}

// TestSkills проверяет, что встроенные промпты агента совпадают байт в байт с skills/ оригинала
// на 634fd94: от них зависит промпт задания сценарного прохода.
func TestSkills(t *testing.T) {
	text, err := Skill(SkillScenario)
	if err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256([]byte(text))
	if got := hex.EncodeToString(sum[:]); got != "94d9dd21ad4979d3cdc7fe1bd5db591dedbde01675b3292626036023bf3ac80e" {
		t.Errorf("ai-clip-scenario/SKILL.md: SHA-256 %s", got)
	}
	if _, err := Skill("missing"); err == nil {
		t.Error("неизвестный скилл должен давать ошибку")
	}
}

// TestProviderDocs проверяет, что документы провайдеров совпадают байт в байт с docs/providers
// оригинала на 634fd94: их раздел «Указания агенту» входит в промпт задания.
func TestProviderDocs(t *testing.T) {
	want := map[[2]string]string{
		{"image", "kling"}: "b9c9a9f12b4427b4e7efa0a8dc636c7559362e58fc5da3c392c11cbc73c99011",
		{"image", "codex"}: "e89d8bbab06d298d29442acbbf53539514d479d532e72701d4142c2d3c819fdb",
		{"video", "kling"}: "609a918e609622e2176c7dbe9a9f516f0409ee9bd53aca33ee8bc252cdf577cc",
	}
	for key, digest := range want {
		data, err := ProviderDoc(key[0], key[1])
		if err != nil {
			t.Fatalf("%s/%s: %v", key[0], key[1], err)
		}
		sum := sha256.Sum256(data)
		if got := hex.EncodeToString(sum[:]); got != digest {
			t.Errorf("%s/%s.md: SHA-256 %s, ожидался %s", key[0], key[1], got, digest)
		}
	}
	if _, err := ProviderDoc("video", "codex"); err == nil {
		t.Error("отсутствующий документ должен давать ошибку")
	}
}
