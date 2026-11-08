package animaticcards

import (
	"errors"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"songframe/internal/golden"
	"songframe/internal/toolrt"
)

// Эталон testdata/golden/animatic-cards: textlength.json — ширины строк, cases.json —
// трассировка карточек. Пиксели глифов не
// сравниваются (растеризация другая), сравниваются раскладка, вставленные изображения и ошибки.

// TestGoldenTextLength — ширина каждой строки совпадает с эталонной шириной до 1/64 px.
func TestGoldenTextLength(t *testing.T) {
	cases, _ := golden.ValueFile(t, "animatic-cards", "textlength.json").([]any)
	if len(cases) == 0 {
		t.Fatal("пустой textlength.json")
	}
	mismatched := 0
	for _, value := range cases {
		entry := value.(*toolrt.Dict)
		text := entry.Value("text").(string)
		size, _ := entry.Value("size").(toolrt.Int).Int64()
		want, _ := entry.Value("width64").(toolrt.Int).Int64()
		f, err := newFace(entry.Value("bold").(bool), int(size))
		if err != nil {
			t.Fatal(err)
		}
		if got := f.length(text); got != int(want) {
			mismatched++
			t.Errorf("textlength(%q, bold=%v, %d) = %d/64, эталон %d/64", text, entry.Value("bold"), size, got, want)
		}
	}
	t.Logf("строк: %d, расхождений: %d", len(cases), mismatched)
}

// intOf — целое поля эталона.
func intOf(value any) int {
	number, _ := value.(toolrt.Int).Int64()
	return int(number)
}

// compareTrace — трассировка Go против эталона: список расхождений.
func compareTrace(expected *toolrt.Dict, tr *trace) []string {
	diffs := []string{}
	texts, _ := expected.Value("texts").([]any)
	if len(texts) != len(tr.Texts) {
		diffs = append(diffs, fmt.Sprintf("вызовов text_box %d, эталон %d", len(tr.Texts), len(texts)))
	}
	for index := 0; index < len(texts) && index < len(tr.Texts); index++ {
		want, got := texts[index].(*toolrt.Dict), tr.Texts[index]
		xy := want.Value("xy").([]any)
		args := fmt.Sprintf("%q %d,%d %dx%d size=%d %s bold=%v", want.Value("text"), intOf(xy[0]), intOf(xy[1]),
			intOf(want.Value("width")), intOf(want.Value("height")), intOf(want.Value("size")), want.Value("color"), want.Value("bold"))
		gotArgs := fmt.Sprintf("%q %d,%d %dx%d size=%d %s bold=%v", got.Text, got.X, got.Y, got.Width, got.Height, got.Size, got.Color, got.Bold)
		if args != gotArgs {
			diffs = append(diffs, fmt.Sprintf("text_box[%d]: %s, эталон %s", index, gotArgs, args))
			continue
		}
		if intOf(want.Value("point")) != got.Point {
			diffs = append(diffs, fmt.Sprintf("text_box[%d] %q: кегль %d, эталон %d", index, got.Text, got.Point, intOf(want.Value("point"))))
		}
		lines := want.Value("lines").([]any)
		wantLines := make([]string, len(lines))
		for position, line := range lines {
			items := line.([]any)
			wantLines[position] = fmt.Sprintf("%d,%d %q", intOf(items[0]), intOf(items[1]), items[2])
		}
		gotLines := make([]string, len(got.Lines))
		for position, line := range got.Lines {
			gotLines[position] = fmt.Sprintf("%d,%d %q", line.X, line.Y, line.Text)
		}
		if strings.Join(wantLines, "\n") != strings.Join(gotLines, "\n") {
			diffs = append(diffs, fmt.Sprintf("text_box[%d] строки:\n  go:     %v\n  эталон: %v", index, gotLines, wantLines))
		}
	}
	pastes, _ := expected.Value("pastes").([]any)
	if len(pastes) != len(tr.Pastes) {
		diffs = append(diffs, fmt.Sprintf("вставок %d, эталон %d", len(tr.Pastes), len(pastes)))
	}
	for index := 0; index < len(pastes) && index < len(tr.Pastes); index++ {
		want, got := pastes[index].(*toolrt.Dict), tr.Pastes[index]
		size, at := want.Value("size").([]any), want.Value("at").([]any)
		if intOf(size[0]) != got.Width || intOf(size[1]) != got.Height || intOf(at[0]) != got.X || intOf(at[1]) != got.Y {
			diffs = append(diffs, fmt.Sprintf("paste[%d]: %dx%d в %d,%d, эталон %dx%d в %d,%d", index, got.Width, got.Height, got.X, got.Y,
				intOf(size[0]), intOf(size[1]), intOf(at[0]), intOf(at[1])))
		}
		if want.Value("exact") == true && want.Value("sha256") != got.SHA256 {
			diffs = append(diffs, fmt.Sprintf("paste[%d]: пиксели отличаются от эталона", index))
		}
	}
	return diffs
}

// TestGoldenCards — render_card и render_keyframe_card на случаях эталона.
func TestGoldenCards(t *testing.T) {
	cases, _ := golden.ValueFile(t, "animatic-cards", "cases.json").([]any)
	base, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	root := filepath.Join(base, "animatic-cards", "project")
	resolved := toolrt.ResolvePath(root)
	matched := 0
	for _, value := range cases {
		entry := value.(*toolrt.Dict)
		name := entry.Value("name").(string)
		expected := entry.Value("expected").(*toolrt.Dict)
		shot := entry.Value("shot").(*toolrt.Dict)
		project := entry.Value("project").(*toolrt.Dict)
		tr := &trace{}
		diffs := []string{}
		var renderErr error
		if entry.Value("call") == "render_card" {
			var result cardResult
			_, result, renderErr = renderCard(shot, project, entry.Value("references").(*toolrt.Dict), root, tr)
			if want, ok := expected.Value("result").(*toolrt.Dict); ok && renderErr == nil {
				if intOf(want.Value("action_font")) != result.ActionFont || intOf(want.Value("state_font")) != result.StateFont ||
					!toolrt.Equal(want.Value("primary_reference"), result.PrimaryReference) || !toolrt.Equal(want.Value("primary_image"), result.PrimaryImage) {
					diffs = append(diffs, fmt.Sprintf("результат %+v, эталон %s", result, toolrt.Repr(want)))
				}
			}
		} else {
			keyframes := []*toolrt.Dict{}
			for _, item := range entry.Value("keyframes").([]any) {
				keyframes = append(keyframes, item.(*toolrt.Dict))
			}
			var last *rgbImage
			_, last, renderErr = renderKeyframeCard(shot, project, keyframes, root, entry.Value("with_last") == true, tr)
			if hasLast := last != nil; renderErr == nil && hasLast != (expected.Value("has_last") == true) {
				diffs = append(diffs, fmt.Sprintf("has_last %v, эталон %v", hasLast, expected.Value("has_last")))
			}
		}
		if want, ok := expected.Value("error").(*toolrt.Dict); ok {
			var exception *toolrt.Exception
			switch {
			case renderErr == nil:
				diffs = append(diffs, fmt.Sprintf("нет ошибки, эталон %s", toolrt.Repr(want)))
			case !errors.As(renderErr, &exception):
				diffs = append(diffs, fmt.Sprintf("ошибка не исключение toolrt: %v", renderErr))
			default:
				message := strings.ReplaceAll(exception.Message, resolved, "<project>")
				if exception.Type != want.Value("type") || message != want.Value("message") {
					diffs = append(diffs, fmt.Sprintf("%s: %s, эталон %s: %s", exception.Type, message, want.Value("type"), want.Value("message")))
				}
			}
		} else if renderErr != nil {
			diffs = append(diffs, fmt.Sprintf("ошибка %v", renderErr))
		}
		diffs = append(diffs, compareTrace(expected, tr)...)
		if len(diffs) == 0 {
			matched++
			continue
		}
		t.Errorf("%s:\n%s", name, strings.Join(diffs, "\n"))
	}
	t.Logf("случаев: %d, совпало: %d", len(cases), matched)
}
