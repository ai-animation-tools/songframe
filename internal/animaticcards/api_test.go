package animaticcards

import (
	"bytes"
	"image"
	"image/png"
	"math"
	"path/filepath"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/toolrt"
)

// goldenInput — вход случая эталона по имени и корень его проекта.
func goldenInput(t *testing.T, name string) (*toolrt.Dict, string) {
	t.Helper()
	base, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	for _, value := range golden.ValueFile(t, "animatic-cards", "cases.json").([]any) {
		if entry := value.(*toolrt.Dict); entry.Value("name") == name {
			return entry, filepath.Join(base, "animatic-cards", "project")
		}
	}
	t.Fatalf("нет случая %s", name)
	return nil, ""
}

// decodeCard проверяет, что байты — PNG 1280×720 с теми же пикселями, что холст.
func decodeCard(t *testing.T, data []byte, want rgbImage) {
	t.Helper()
	decoded, err := png.Decode(bytes.NewReader(data))
	if err != nil {
		t.Fatal(err)
	}
	if decoded.Bounds() != image.Rect(0, 0, cardWidth, cardHeight) {
		t.Fatalf("размер %v", decoded.Bounds())
	}
	if got := toRGB(decoded); !bytes.Equal(got.pix, want.pix) {
		t.Fatal("PNG не совпадает с холстом")
	}
}

// TestRenderCardAPI — публичный RenderCard кодирует тот же холст, что внутренний рендер.
func TestRenderCardAPI(t *testing.T) {
	entry, root := goldenInput(t, "basic")
	shot, project := entry.Value("shot").(*toolrt.Dict), entry.Value("project").(*toolrt.Dict)
	references := entry.Value("references").(*toolrt.Dict)
	data, err := RenderCard(shot, project, references, root)
	if err != nil {
		t.Fatal(err)
	}
	canvas, _, err := renderCard(shot, project, references, root, nil)
	if err != nil {
		t.Fatal(err)
	}
	decodeCard(t, data, canvas.img)
	if _, err := RenderCard(shot, toolrt.NewDict(), references, root); !toolrt.Is(err, toolrt.KeyError) {
		t.Fatalf("без name — KeyError, получено %v", err)
	}
}

// TestRenderKeyframeCardAPI — последняя опора возвращается только при withLast и двух опорах.
func TestRenderKeyframeCardAPI(t *testing.T) {
	entry, root := goldenInput(t, "keyframes-three")
	shot, project := entry.Value("shot").(*toolrt.Dict), entry.Value("project").(*toolrt.Dict)
	keyframes := []*toolrt.Dict{}
	for _, item := range entry.Value("keyframes").([]any) {
		keyframes = append(keyframes, item.(*toolrt.Dict))
	}
	card, last, err := RenderKeyframeCard(shot, project, keyframes, root, true)
	if err != nil || card == nil || last == nil {
		t.Fatalf("три опоры: card=%v last=%v err=%v", card != nil, last != nil, err)
	}
	lastPath, _ := keyframePath(keyframes[2], root)
	lastCanvas, err := fitCanvas(lastPath, nil)
	if err != nil {
		t.Fatal(err)
	}
	decodeCard(t, last, lastCanvas)
	if _, last, err = RenderKeyframeCard(shot, project, keyframes, root, false); err != nil || last != nil {
		t.Fatalf("без withLast: last=%v err=%v", last != nil, err)
	}
	if _, last, err = RenderKeyframeCard(shot, project, keyframes[:1], root, true); err != nil || last != nil {
		t.Fatalf("одна опора: last=%v err=%v", last != nil, err)
	}
	if _, _, err = RenderKeyframeCard(shot, project, nil, root, true); !toolrt.Is(err, toolrt.ValueError) || err.Error() != "Нет принятых опор для карточки." {
		t.Fatalf("пустой список: %v", err)
	}
}

// TestFormatG — формат «g» и ошибки formatG на краевых значениях.
func TestFormatG(t *testing.T) {
	big, _ := toolrt.ParseInt("1" + string(bytes.Repeat([]byte("0"), 400)))
	for _, item := range []struct {
		value any
		want  string
		kind  string
	}{
		{0.0, "0", ""}, {math.Copysign(0, -1), "-0", ""}, {2.5, "2.5", ""}, {toolrt.NewInt(5), "5", ""}, {true, "1", ""},
		{1234567.0, "1.23457e+06", ""}, {100000.0, "100000", ""}, {0.0001, "0.0001", ""}, {1e-05, "1e-05", ""},
		{1e16, "1e+16", ""}, {"0", "", toolrt.ValueError}, {nil, "", toolrt.TypeError}, {big, "", toolrt.OverflowError},
	} {
		got, err := formatG(item.value)
		if item.kind != "" {
			if !toolrt.Is(err, item.kind) {
				t.Errorf("formatG(%s): ошибка %v, ожидалась %s", toolrt.Repr(item.value), err, item.kind)
			}
			continue
		}
		if err != nil || got != item.want {
			t.Errorf("formatG(%s) = %q, %v; ожидалось %q", toolrt.Repr(item.value), got, err, item.want)
		}
	}
}

// TestToUpper — прописные с безусловными правилами SpecialCasing.
func TestToUpper(t *testing.T) {
	for text, want := range map[string]string{"ёлка": "ЁЛКА", "straße": "STRASSE", "ﬁlm": "FILM", "ᾳ": "ΑΙ", "Огород M03": "ОГОРОД M03"} {
		if got := toUpper(text); got != want {
			t.Errorf("upper(%q) = %q, ожидалось %q", text, got, want)
		}
	}
}
