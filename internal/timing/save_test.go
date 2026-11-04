package timing

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/projectfs"
)

// TestSaveProjectMatchesOriginal выполняет saveTiming целиком на копии каждого эталона timing-save:
// записанные байты совпадают с expected-timing.json, повторное сохранение результата не меняет файл,
// а отказ проверки (validation-error) оставляет прежний timing.json байт в байт.
func TestSaveProjectMatchesOriginal(t *testing.T) {
	for _, item := range golden.Load(t, "timing-save") {
		t.Run(item.Name, func(t *testing.T) {
			var want struct {
				Error         *string `json:"error"`
				FileUnchanged bool    `json:"fileUnchanged"`
				Resave        *struct {
					SameBytes bool `json:"sameBytes"`
				} `json:"resave"`
			}
			if err := json.Unmarshal(item.Expected(t), &want); err != nil {
				t.Fatal(err)
			}
			path := item.CopyProject(t)
			target := filepath.Join(path, filepath.FromSlash(TimingPath))
			before, beforeErr := os.ReadFile(target)
			input, err := jscompat.Parse(item.Read(t, "timing-input.json"))
			if err != nil {
				t.Fatal(err)
			}
			result, err := SaveProject(path, input)
			if want.Error != nil {
				if err == nil || err.Error() != *want.Error {
					t.Fatalf("ожидался отказ %q, получено %v", *want.Error, err)
				}
				after, afterErr := os.ReadFile(target)
				if want.FileUnchanged && (string(after) != string(before) || (beforeErr == nil) != (afterErr == nil)) {
					t.Fatal("отказ сохранения изменил timing.json")
				}
				return
			}
			if err != nil {
				t.Fatal(err)
			}
			written, err := os.ReadFile(target)
			if err != nil {
				t.Fatal(err)
			}
			if string(written) != string(item.Read(t, "expected-timing.json")) {
				t.Fatalf("байты записанного файла отличаются от оригинала:\n%s", written)
			}
			if _, err := SaveProject(path, result); err != nil {
				t.Fatal(err)
			}
			again, _ := os.ReadFile(target)
			if want.Resave != nil && want.Resave.SameBytes && string(again) != string(written) {
				t.Fatal("повторное сохранение изменило байты файла")
			}
		})
	}
}

// TestSaveProjectRespectsWriteGate — незавершённая публикация монтажа запрещает запись разметки:
// прежний файл не меняется, причина — BlockedError шлюза.
func TestSaveProjectRespectsWriteGate(t *testing.T) {
	cases := golden.Load(t, "timing-save")
	var item golden.Case
	for _, candidate := range cases {
		if candidate.Name == "sample-resave" {
			item = candidate
		}
	}
	if item.Name == "" {
		t.Fatal("нет эталона sample-resave")
	}
	path := item.CopyProject(t)
	journal := filepath.Join(path, "plan", "montage-history", "attempt", "journal.json")
	if err := os.MkdirAll(filepath.Dir(journal), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(journal, []byte(`{"state":"publishing"}`), 0o600); err != nil {
		t.Fatal(err)
	}
	target := filepath.Join(path, filepath.FromSlash(TimingPath))
	before, _ := os.ReadFile(target)
	input, err := jscompat.Parse(item.Read(t, "timing-input.json"))
	if err != nil {
		t.Fatal(err)
	}
	_, err = SaveProject(path, input)
	var blocked *projectfs.BlockedError
	if !errors.As(err, &blocked) {
		t.Fatalf("ожидался запрет записи, получено %v", err)
	}
	after, _ := os.ReadFile(target)
	if string(after) != string(before) {
		t.Fatal("запрещённая запись изменила файл")
	}
}
