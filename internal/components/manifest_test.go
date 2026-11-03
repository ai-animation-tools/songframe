package components

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"io"
	"os"
	"path/filepath"
	"testing"
)

// TestManifestContract фиксирует принятый состав и разделение статической проверки/приёмки.
// Рецепт сверяется отдельно с исходным lock при изменении, соседний spec тестам не требуется.
func TestManifestContract(t *testing.T) {
	m, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	if len(m.Artifacts) != 7 {
		t.Fatalf("изменён состав принятого набора: %d", len(m.Artifacts))
	}
	var recipe struct {
		CTC struct {
			Scoring     string `json:"scoring"`
			PausePolicy string `json:"pause_policy"`
			ManualTimes bool   `json:"manual_times_input"`
			Whisper     bool   `json:"whisper_input"`
		} `json:"ctc"`
	}
	if err := json.Unmarshal(m.Recipe, &recipe); err != nil {
		t.Fatal(err)
	}
	if recipe.CTC.Scoring != "margin" || recipe.CTC.PausePolicy != "adaptive" || recipe.CTC.ManualTimes || recipe.CTC.Whisper {
		t.Fatal("изменён принятый CTC-путь")
	}
	var models int64
	for _, a := range m.Artifacts {
		if a.OS == "any" {
			models += a.Bytes
			if a.Arch != "any" {
				t.Fatal(a.ID)
			}
		}
		if a.Component == "ort-cpu" && (a.ABI.RequiredAPI != 27 || a.ABI.HeaderAPI != 31 || a.NativeStatus != "pending_session_and_inference") {
			t.Fatal("смешаны API binding и runtime либо выдана непроверенная готовность")
		}
	}
	if models != 384112928 {
		t.Fatalf("изменён размер закреплённых моделей: %d", models)
	}
	// Каждый Load возвращает собственные slices/maps: потребитель не меняет глобальный lock.
	m.Artifacts[0].Files[0].Path = "испорчено"
	fresh, err := Load()
	if err != nil || fresh.Artifacts[0].Files[0].Path == "испорчено" {
		t.Fatal("реестр разделяет изменяемое состояние")
	}
}

// TestManifestRejectsBrokenContracts проверяет ошибки, опасные для будущей установки.
// Успешное JSON-чтение само по себе не доказывает связность зависимостей или полноту комплекта.
func TestManifestRejectsBrokenContracts(t *testing.T) {
	cases := map[string]func(*Manifest){
		"entrypoint": func(m *Manifest) {
			m.Artifacts[0].Entrypoints = map[string]string{"ffmpeg": "не существует"}
		},
		"пустой рецепт": func(m *Manifest) { m.Recipe = json.RawMessage(`null`) },
		"нет модели":    func(m *Manifest) { m.Artifacts[4].Model = nil },

		"хеш":                  func(m *Manifest) { m.Artifacts[0].SHA256 = "не SHA" },
		"адрес":                func(m *Manifest) { m.Artifacts[0].URL = "file:///tmp/pack" },
		"размер":               func(m *Manifest) { m.Artifacts[0].Bytes = 0 },
		"потерянный vocab":     func(m *Manifest) { m.Artifacts = m.Artifacts[:len(m.Artifacts)-1] },
		"повторный пакет":      func(m *Manifest) { m.Artifacts[1].ID = m.Artifacts[0].ID },
		"потерянный probe":     func(m *Manifest) { m.Probes = m.Probes[1:] },
		"выход из архива":      func(m *Manifest) { m.Artifacts[0].Files[0].Path = "../ffmpeg" },
		"windows путь":         func(m *Manifest) { m.Artifacts[0].Files[0].Path = `C:\ffmpeg.exe` },
		"лицензия":             func(m *Manifest) { m.Artifacts[0].License.Sources = nil },
		"готовность платформы": func(m *Manifest) { m.Platforms[1].Status = "ready" },
	}
	for name, change := range cases {
		t.Run(name, func(t *testing.T) {
			m, err := Load()
			if err != nil {
				t.Fatal(err)
			}
			change(&m)
			if m.Validate() == nil {
				t.Fatal("ошибка manifest не обнаружена")
			}
		})
	}
	for _, suffix := range []string{` {}`, ` мусор`} {
		if _, err := parse(append(append([]byte{}, manifestJSON...), suffix...)); err == nil {
			t.Fatal("приняты данные после JSON")
		}
	}
	var fields map[string]any
	if err := json.Unmarshal(manifestJSON, &fields); err != nil {
		t.Fatal(err)
	}
	fields["опечатка"] = true
	bad, _ := json.Marshal(fields)
	if _, err := parse(bad); err == nil {
		t.Fatal("принято неизвестное поле")
	}
}

// TestManifestArtifactFiles по явной карте путей сверяет реальные распакованные файлы.
// Проверка добровольная, офлайн и только для разработчика: штатный тест не требует пакетов/моделей.
// SONGFRAME_COMPONENT_ROOTS содержит JSON {artifact_id: каталог_внутри_распакованного_архива}.
func TestManifestArtifactFiles(t *testing.T) {
	raw := os.Getenv("SONGFRAME_COMPONENT_ROOTS")
	if raw == "" {
		t.Skip("не заданы явные каталоги артефактов")
	}
	roots := map[string]string{}
	if err := json.Unmarshal([]byte(raw), &roots); err != nil {
		t.Fatal(err)
	}
	if len(roots) == 0 {
		t.Fatal("карта каталогов пуста")
	}
	m, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	for _, a := range m.Artifacts {
		root, ok := roots[a.ID]
		if !ok {
			continue
		}
		delete(roots, a.ID)
		t.Run(a.ID, func(t *testing.T) {
			for _, file := range a.Files {
				name := filepath.Join(root, filepath.FromSlash(file.Path))
				if file.Type == "symlink" {
					target, err := os.Readlink(name)
					if err != nil || target != file.Target {
						t.Fatalf("неверная ссылка %s: %s, %v", file.Path, target, err)
					}
					continue
				}
				f, err := os.Open(name)
				if err != nil {
					t.Fatal(err)
				}
				hash := sha256.New()
				n, err := io.Copy(hash, f)
				f.Close()
				if err != nil || n != file.Bytes || hex.EncodeToString(hash.Sum(nil)) != file.SHA256 {
					t.Fatalf("состав не совпал: %s, байты=%d, ошибка=%v", file.Path, n, err)
				}
			}
		})
	}
	if len(roots) > 0 {
		t.Fatalf("неизвестные ID пакетов: %v", roots)
	}
}
