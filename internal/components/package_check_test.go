package components

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"path/filepath"
	"testing"
)

// packageCheckFixture формирует четыре маленьких офлайн-источника с настоящими архивами и SHA.
// Реальный установщик/обнаружение сохраняются; только native и FFmpeg процессы заменены тестовыми границами.
func packageCheckFixture(t *testing.T) (PackageCheckRequest, func(string) (*Manager, error), *int) {
	t.Helper()
	m, _, native := testManager(t)
	request := PackageCheckRequest{ProfileDirectory: filepath.Join(t.TempDir(), "Новый профиль с пробелами"), LocalFiles: map[string]string{}}
	for _, id := range []string{"ffmpeg", "ort-cpu", "ctc-ru", "ctc-vocab"} {
		root := installSynthetic(t, m, id)
		for ai := range m.manifest.Artifacts {
			a := &m.manifest.Artifacts[ai]
			if a.Component != id || (a.OS != "any" && a.OS != "linux") {
				continue
			}
			var data []byte
			a.UnpackedBytes = 0
			for _, f := range a.Files {
				if f.Type != "symlink" {
					a.UnpackedBytes += f.Bytes
				}
			}
			a.InstallBytes = a.UnpackedBytes
			if id == "ffmpeg" || id == "ort-cpu" {
				a.Format, a.Root = "tar.gz", "payload"
				var output bytes.Buffer
				gz := gzip.NewWriter(&output)
				tarWriter := tar.NewWriter(gz)
				for _, f := range a.Files {
					header := &tar.Header{Name: "payload/" + f.Path, Mode: 0755, Typeflag: tar.TypeReg, Size: f.Bytes}
					var payload []byte
					if f.Type == "symlink" {
						header.Typeflag, header.Linkname, header.Size = tar.TypeSymlink, f.Target, 0
					} else {
						var err error
						payload, err = os.ReadFile(filepath.Join(root, filepath.FromSlash(f.Path)))
						if err != nil {
							t.Fatal(err)
						}
					}
					if err := tarWriter.WriteHeader(header); err != nil {
						t.Fatal(err)
					}
					if _, err := tarWriter.Write(payload); err != nil {
						t.Fatal(err)
					}
				}
				if err := tarWriter.Close(); err != nil {
					t.Fatal(err)
				}
				if err := gz.Close(); err != nil {
					t.Fatal(err)
				}
				data = output.Bytes()
			} else {
				var err error
				data, err = os.ReadFile(filepath.Join(root, a.Files[0].Path))
				if err != nil {
					t.Fatal(err)
				}
			}
			sum := sha256.Sum256(data)
			a.Bytes, a.SHA256 = int64(len(data)), hex.EncodeToString(sum[:])
			request.LocalFiles[id] = offlinePayload(t, data)
		}
	}
	return request, func(profile string) (*Manager, error) {
		return newManager(profile, m.manifest, m.options), nil
	}, native
}

// TestPackageCheckInstallAndReadiness требует реальную публикацию и отдельно подтверждённый native результат.
// Отказ графа обязан попасть в JSON-отчёт даже тогда, когда Manager.Check не возвращает общую ошибку.
func TestPackageCheckInstallAndReadiness(t *testing.T) {
	for _, scenario := range []string{"ready", "model-rejected", "hash-rejected"} {
		t.Run(scenario, func(t *testing.T) {
			request, factory, native := packageCheckFixture(t)
			if scenario == "model-rejected" {
				originalFactory := factory
				factory = func(profile string) (*Manager, error) {
					m, err := originalFactory(profile)
					originalProbe := m.options.ort
					m.options.ort = func(ctx context.Context, path string, models []ModelFile) (ORTReport, error) {
						report, err := originalProbe(ctx, path, models)
						report.Models["ctc-ru"] = ProbeOutcome{Status: "incompatible", Reason: "отказ синтетического inference"}
						return report, err
					}
					return m, err
				}
			}
			if scenario == "hash-rejected" {
				if err := os.WriteFile(request.LocalFiles["ctc-ru"], []byte("повреждённая модель"), 0600); err != nil {
					t.Fatal(err)
				}
			}
			originals := map[string][]byte{}
			for id, name := range request.LocalFiles {
				var err error
				originals[id], err = os.ReadFile(name)
				if err != nil {
					t.Fatal(err)
				}
			}
			report, err := packageCheck(context.Background(), request, factory)
			if scenario == "ready" {
				if err != nil || report.Status != "ready" || *native != 1 || report.Installation.Status != "installed" || operation(t, report.Snapshot, "ctc-existing-vocals").Status != "ready" {
					t.Fatalf("нет готовности после установки: %+v %v native=%d", report, err, *native)
				}
				for _, id := range []string{"ffmpeg", "ort-cpu", "ctc-ru", "ctc-vocab"} {
					if c := component(t, report.Snapshot, id); c.Source != "managed" || c.Status != "ready" {
						t.Fatalf("использован чужой компонент: %+v", c)
					}
				}
			} else if err == nil || report.Status != "error" || report.Error == "" {
				t.Fatalf("скрыт отказ %s: %+v %v", scenario, report, err)
			}
			if scenario == "hash-rejected" && *native != 0 {
				t.Fatal("повреждённая модель дошла до native loader")
			}
			encoded, err := json.Marshal(report)
			if err != nil || !json.Valid(encoded) {
				t.Fatalf("отчёт не сериализуется: %v", err)
			}
			for id, name := range request.LocalFiles {
				data, err := os.ReadFile(name)
				if err != nil || !bytes.Equal(data, originals[id]) {
					t.Fatalf("изменён исходник %s: %v", id, err)
				}
			}
		})
	}
}

// TestPackageCheckExistingFFmpeg подтверждает reuse готовой внешней пары без управляемой копии.
// Остальные три компонента устанавливаются с SHA как прежде, а отсутствие ffprobe останавливает проверку.
func TestPackageCheckExistingFFmpeg(t *testing.T) {
	for _, complete := range []bool{true, false} {
		t.Run(map[bool]string{true: "complete", false: "missing-ffprobe"}[complete], func(t *testing.T) {
			request, factory, native := packageCheckFixture(t)
			pair := externalPair(t)
			request.LocalFiles["ffmpeg"] = filepath.Join(pair, "ffmpeg")
			if !complete {
				if err := os.Remove(filepath.Join(pair, "ffprobe")); err != nil {
					t.Fatal(err)
				}
			}
			report, err := packageCheck(context.Background(), request, factory)
			if !complete {
				if err == nil || report.Status != "error" || *native != 0 {
					t.Fatalf("неполная пара принята: %+v %v native=%d", report, err, *native)
				}
				return
			}
			if err != nil || report.Status != "ready" || *native != 1 || report.Installation.Status != "installed" {
				t.Fatalf("готовая пара не использована: %+v %v native=%d", report, err, *native)
			}
			media := component(t, report.Snapshot, "ffmpeg")
			if media.Source != "explicit" || media.Paths["ffmpeg"] != request.LocalFiles["ffmpeg"] || media.Status != "ready" {
				t.Fatalf("сменился внешний FFmpeg: %+v", media)
			}
			for _, id := range []string{"ort-cpu", "ctc-ru", "ctc-vocab"} {
				if state := component(t, report.Snapshot, id); state.Source != "managed" || state.Status != "ready" {
					t.Fatalf("компонент не установлен: %+v", state)
				}
			}
			for _, name := range []string{"ffmpeg", "ffprobe"} {
				data, err := os.ReadFile(filepath.Join(pair, name))
				if err != nil || string(data) != "синтетический бинарник" {
					t.Fatalf("внешний файл изменён: %s %v", name, err)
				}
			}
			if _, err := os.Stat(filepath.Join(request.ProfileDirectory, "components", "ffmpeg-linux-amd64")); !os.IsNotExist(err) {
				t.Fatalf("создана ненужная копия FFmpeg: %v", err)
			}
		})
	}
}

// TestPackageCheckRejectsUnsafeInputs проверяет ошибки до установки и не допускает сетевой fallback.
// Существующий профиль остаётся побайтно нетронутым; неполный ввод не создаёт новый каталог.
func TestPackageCheckRejectsUnsafeInputs(t *testing.T) {
	for _, scenario := range []string{"existing-profile", "missing-source", "relative-profile", "relative-source", "directory-source", "unknown-source", "cancelled"} {
		t.Run(scenario, func(t *testing.T) {
			request, _, _ := packageCheckFixture(t)
			ctx := context.Background()
			switch scenario {
			case "existing-profile":
				if err := os.Mkdir(request.ProfileDirectory, 0700); err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(filepath.Join(request.ProfileDirectory, "components.json"), []byte("пользовательские данные"), 0600); err != nil {
					t.Fatal(err)
				}
			case "missing-source":
				delete(request.LocalFiles, "ort-cpu")
			case "relative-profile":
				request.ProfileDirectory = "relative-profile"
			case "relative-source":
				request.LocalFiles["ort-cpu"] = "relative-runtime.tar.gz"
			case "directory-source":
				request.LocalFiles["ort-cpu"] = t.TempDir()
			case "unknown-source":
				request.LocalFiles["unknown"] = request.LocalFiles["ort-cpu"]
				delete(request.LocalFiles, "ort-cpu")
			case "cancelled":
				var cancel context.CancelFunc
				ctx, cancel = context.WithCancel(ctx)
				cancel()
			}
			report, err := packageCheck(ctx, request, func(string) (*Manager, error) {
				t.Fatal("некорректный запрос дошёл до менеджера")
				return nil, nil
			})
			if err == nil || report.Status == "ready" || report.Error == "" {
				t.Fatalf("некорректный ввод принят: %+v %v", report, err)
			}
			if scenario == "existing-profile" {
				data, err := os.ReadFile(filepath.Join(request.ProfileDirectory, "components.json"))
				if err != nil || string(data) != "пользовательские данные" {
					t.Fatal("существующий профиль изменён")
				}
			} else if _, err := os.Stat(request.ProfileDirectory); !os.IsNotExist(err) {
				t.Fatalf("создан профиль при некорректном вводе: %v", err)
			}
		})
	}
}
