package resources

import (
	"crypto/sha256"
	"encoding/hex"
	"testing"
)

// TestFonts закрепляет SHA-256 встроенных шрифтов и лицензии: от метрик шрифтов зависят ширины
// строк карточек аниматика.
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

// TestSkills закрепляет SHA-256 встроенного промпта сценарного прохода: от него зависит промпт
// задания, поэтому любая правка должна быть осознанной.
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

// TestProviderDocs закрепляет SHA-256 встроенных документов провайдеров: их раздел «Указания
// агенту» входит в промпт задания, поэтому любая правка документа должна быть осознанной. Байты
// самого раздела дополнительно сверяют эталоны промптов (internal/providers, TestGuidesGolden).
func TestProviderDocs(t *testing.T) {
	want := map[[2]string]string{
		{"image", "kling"}: "3c85eafc2594fa04e6cf16690af45df0515d81ee39d8c47fb1bfd84d5dbb54b2",
		{"image", "codex"}: "109a423e5eb1b66d2fccb1635a770bbb0c3d91ad8766274f6a263cd22153610b",
		{"video", "kling"}: "729b248ce491f7865e2454baa62d00ce97497916cdc649174f14c72209d77f99",
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
