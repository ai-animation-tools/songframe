package golden

import (
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// Случаи проверок проекта (lint-registry, check-assets, check-workspace, shot-status) хранят не
// копию проекта, а разность с общим образцом: case.json.base — домен с каталогом project/
// (checks-base), overlay/ случая — новые и изменённые файлы, case.json.remove — удалённые файлы и
// каталоги, case.json.mkdir — пустые каталоги, которых не бывает в Git. Разность вычислил скрипт
// съёмки по дереву после правки; полная копия образца в каждом случае заняла бы десятки мегабайт.

// overlaySpec — поля case.json, описывающие разность входа с образцом.
type overlaySpec struct {
	Base    string   `json:"base"`
	Project *string  `json:"project"`
	Remove  []string `json:"remove"`
	Mkdir   []string `json:"mkdir"`
}

// BuildProject собирает вход случая в t.TempDir()/project: копия <base>/project, поверх — overlay/
// случая, затем удаление путей remove и создание пустых каталогов mkdir. Для случая без проекта
// (project: null) возвращает несуществующий путь с тем же basename. Эталон в testdata не меняется.
func (c Case) BuildProject(t testing.TB) string {
	t.Helper()
	var spec overlaySpec
	if err := json.Unmarshal(c.Read(t, "case.json"), &spec); err != nil {
		t.Fatalf("case.json %s/%s: %v", c.Domain, c.Name, err)
	}
	target := filepath.Join(t.TempDir(), projectDir)
	if spec.Project == nil {
		return target
	}
	if spec.Base == "" {
		t.Fatalf("случай %s/%s без base", c.Domain, c.Name)
	}
	if err := copyTree(filepath.Join(mustRoot(t), spec.Base, projectDir), target); err != nil {
		t.Fatalf("образец %s: %v", spec.Base, err)
	}
	if overlay := filepath.Join(c.Dir, "overlay"); exists(overlay) {
		if err := copyTree(overlay, target); err != nil {
			t.Fatalf("overlay %s/%s: %v", c.Domain, c.Name, err)
		}
	}
	for _, path := range spec.Remove {
		if err := os.RemoveAll(filepath.Join(target, filepath.FromSlash(path))); err != nil {
			t.Fatal(err)
		}
	}
	for _, path := range spec.Mkdir {
		if err := os.MkdirAll(filepath.Join(target, filepath.FromSlash(path)), 0o755); err != nil {
			t.Fatal(err)
		}
	}
	return target
}

// exists — путь существует.
func exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}
