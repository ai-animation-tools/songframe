package timing

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/jscompat"
)

// TestViewMatchesGolden сверяет ViewProject с эталонами timing-view и неизменность входа.
func TestViewMatchesGolden(t *testing.T) {
	for _, item := range golden.Load(t, "timing-view") {
		t.Run(item.Name, func(t *testing.T) {
			path := item.ProjectPath()
			before := digestIfExists(t, path)
			view, err := ViewProject(path)
			if err != nil {
				t.Fatal(err)
			}
			golden.AssertValue(t, item.Expected(t), view, path)
			if digestIfExists(t, path) != before {
				t.Fatal("просмотр разметки изменил файлы проекта")
			}
		})
	}
}

// TestValidateMatchesGolden сверяет validateTiming с timing-validation/cases.json.
func TestValidateMatchesGolden(t *testing.T) {
	for _, item := range golden.ValidationCases(t) {
		t.Run(item.Name, func(t *testing.T) {
			timing, err := jscompat.Parse(item.Input.Timing)
			if err != nil {
				t.Fatal(err)
			}
			var lyrics []LyricsLine
			if err := json.Unmarshal(item.Input.Lyrics, &lyrics); err != nil {
				t.Fatal(err)
			}
			problems, err := Validate(timing, lyrics, item.Input.Duration)
			if err != nil {
				t.Fatal(err)
			}
			want, _ := json.Marshal(item.Expected)
			golden.AssertValue(t, want, problems, "")
		})
	}
}

// TestValidateSaveInputs проверяет проверку разметки на входах timing-save: отклонённое
// сохранение (validation-error) должно давать проблемы, остальные — нет.
func TestValidateSaveInputs(t *testing.T) {
	for _, item := range golden.Load(t, "timing-save") {
		t.Run(item.Name, func(t *testing.T) {
			var want struct {
				Error *string `json:"error"`
			}
			if err := json.Unmarshal(item.Expected(t), &want); err != nil {
				t.Fatal(err)
			}
			view, err := ViewProject(item.ProjectPath())
			if err != nil {
				t.Fatal(err)
			}
			input, err := jscompat.Parse(item.Read(t, "timing-input.json"))
			if err != nil {
				t.Fatal(err)
			}
			problems, err := Validate(input, view.Lyrics, view.Duration)
			if err != nil {
				t.Fatal(err)
			}
			joined := ""
			for index, problem := range problems {
				if index > 0 {
					joined += " "
				}
				joined += problem
			}
			switch {
			case want.Error == nil && len(problems) > 0:
				t.Fatalf("эталон сохранил, Go видит проблемы: %v", problems)
			case want.Error != nil && joined != *want.Error:
				t.Fatalf("ошибка сохранения %q, Go: %q", *want.Error, joined)
			}
		})
	}
}

// TestAnalyzeLyricsEdges — пустой текст и JS-правила пробелов и регистра.
func TestAnalyzeLyricsEdges(t *testing.T) {
	if rows := ParseLyricsLines(""); len(rows) != 1 || rows[0].Text != "" {
		t.Fatalf("пустой текст: %+v", rows)
	}
	// NBSP — пробел \s в JS, поэтому строка — Markdown-список.
	if rows := ParseLyricsLines("- пункт"); !rows[0].Header {
		t.Fatal("NBSP после маркера списка не распознан")
	}
	// Флаг i JS без u не сопоставляет «ſ» латинской s: строка остаётся строкой песни.
	if rows := ParseLyricsLines("ſolo припев"); rows[0].Header {
		t.Fatal("«ſ» сопоставлен латинице")
	}
	if rows := ParseLyricsLines("Второй ПРИПЕВ:"); !rows[0].Header {
		t.Fatal("название части без скобок не распознано")
	}
}

func digestIfExists(t *testing.T, path string) string {
	t.Helper()
	if _, err := os.Stat(path); err != nil {
		return ""
	}
	digest, err := golden.TreeDigest(path)
	if err != nil {
		t.Fatal(err)
	}
	return digest
}

// TestPrepareMatchesGolden сверяет чистую часть saveTiming с эталонами timing-save: документ,
// байты файла (expected-timing.json) и отказ с текстом проблем. Запись не выполняется, поэтому
// вход эталона не меняется.
func TestPrepareMatchesGolden(t *testing.T) {
	for _, item := range golden.Load(t, "timing-save") {
		t.Run(item.Name, func(t *testing.T) {
			var want struct {
				Error  *string         `json:"error"`
				Result json.RawMessage `json:"result"`
				Resave *struct {
					SameResult bool `json:"sameResult"`
					SameBytes  bool `json:"sameBytes"`
				} `json:"resave"`
			}
			if err := json.Unmarshal(item.Expected(t), &want); err != nil {
				t.Fatal(err)
			}
			path := item.ProjectPath()
			before := digestIfExists(t, path)
			input, err := jscompat.Parse(item.Read(t, "timing-input.json"))
			if err != nil {
				t.Fatal(err)
			}
			result, err := Prepare(path, input)
			if want.Error != nil {
				if err == nil || err.Error() != *want.Error {
					t.Fatalf("ожидался отказ %q, получено %v", *want.Error, err)
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			golden.AssertValue(t, want.Result, result, path)
			if got, expected := string(Encode(result)), string(item.Read(t, "expected-timing.json")); got != expected {
				t.Fatalf("байты файла отличаются:\n%s\n---\n%s", got, expected)
			}
			if digestIfExists(t, path) != before {
				t.Fatal("Prepare изменил файлы проекта")
			}
		})
	}
}

// TestPrepareIsStable — повторная подготовка уже сохранённого документа даёт те же байты
// (resave.sameBytes эталонов); запись выполняется только на копии входа.
func TestPrepareIsStable(t *testing.T) {
	for _, item := range golden.Load(t, "timing-save") {
		t.Run(item.Name, func(t *testing.T) {
			path := item.CopyProject(t)
			input, err := jscompat.Parse(item.Read(t, "timing-input.json"))
			if err != nil {
				t.Fatal(err)
			}
			result, err := Prepare(path, input)
			if err != nil {
				return
			}
			target := filepath.Join(path, "plan", "audio", "timing.json")
			if err := os.MkdirAll(filepath.Dir(target), 0o755); err != nil {
				t.Fatal(err)
			}
			first := Encode(result)
			if err := os.WriteFile(target, first, 0o600); err != nil {
				t.Fatal(err)
			}
			again, err := Prepare(path, result)
			if err != nil {
				t.Fatal(err)
			}
			if string(Encode(again)) != string(first) {
				t.Fatal("повторное сохранение меняет файл")
			}
		})
	}
}
