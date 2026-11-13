package components

import (
	"archive/tar"
	"archive/zip"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"

	"github.com/ulikunitz/xz"
)

// installationFixture строит маленький закреплённый пакет без настоящих моделей и native вызовов.
func installationFixture(t *testing.T) (*Manager, Artifact, []byte) {
	t.Helper()
	data := []byte("небольшой проверенный компонент")
	sum := sha256.Sum256(data)
	hash := hex.EncodeToString(sum[:])
	a := Artifact{ID: "voc-ft", Component: "voc-ft", Version: "test-v1", OS: "any", Arch: "any", Format: "file", Bytes: int64(len(data)), UnpackedBytes: int64(len(data)), InstallBytes: int64(len(data)), SHA256: hash, Files: []File{{Path: "vocals.onnx", Type: "file", Bytes: int64(len(data)), SHA256: hash}}, Entrypoints: map[string]string{"model": "vocals.onnx"}}
	m := newManager(t.TempDir(), Manifest{Artifacts: []Artifact{a}}, managerOptions{os: "linux", arch: "amd64", lookPath: func(string) (string, error) { return "", os.ErrNotExist }})
	return m, a, data
}

// offlinePayload создаёт вход на другом носителе; его сохранность проверяется после установки.
func offlinePayload(t *testing.T, data []byte) string {
	t.Helper()
	name := filepath.Join(t.TempDir(), "носитель с пробелами.onnx")
	if err := os.WriteFile(name, data, 0600); err != nil {
		t.Fatal(err)
	}
	return name
}

func TestInstallOfflineAndRestart(t *testing.T) {
	m, a, data := installationFixture(t)
	selected := filepath.Join(t.TempDir(), "Компоненты с пробелами")
	if _, err := m.Configure(Selection{ManagedDirectory: selected}); err != nil {
		t.Fatal(err)
	}
	local := offlinePayload(t, data)
	result, err := m.Install(context.Background(), InstallRequest{Components: []string{"voc-ft"}, LocalFiles: map[string]string{"voc-ft": local}})
	if err != nil || result.Status != "installed" {
		t.Fatalf("%+v %v", result, err)
	}
	installed := filepath.Join(managedArtifactDirectory(selected, a), "vocals.onnx")
	got, err := os.ReadFile(installed)
	if err != nil || !bytes.Equal(got, data) {
		t.Fatalf("installed %q %v", got, err)
	}
	original, _ := os.ReadFile(local)
	if !bytes.Equal(original, data) {
		t.Fatal("внешний файл изменён")
	}
	state := m.State()
	if state.Components[2].Status == "ready" {
		t.Fatal("установка не заменяет native probe")
	}
	restarted := newManager(m.profile, m.manifest, m.options)
	if restarted.Installation().Status != "installed" || managedArtifactDirectory(selected, a) != filepath.Dir(installed) {
		t.Fatal("состояние установки потеряно после перезапуска")
	}
	if restarted.State().Components[2].Status != "unchecked" {
		t.Fatalf("%+v", restarted.State())
	}
}

func TestInstallFailuresPreservePrevious(t *testing.T) {
	for _, kind := range []string{"hash", "space", "write", "rename", "cancel"} {
		t.Run(kind, func(t *testing.T) {
			m, a, data := installationFixture(t)
			local := offlinePayload(t, data)
			request := InstallRequest{Components: []string{"voc-ft"}, LocalFiles: map[string]string{"voc-ft": local}}
			if _, err := m.Install(context.Background(), request); err != nil {
				t.Fatal(err)
			}
			root := filepath.Join(m.profile, "components")
			old := managedArtifactDirectory(root, a)
			pointer, _ := os.ReadFile(filepath.Join(root, a.ID, "active.json"))
			ctx := context.Background()
			switch kind {
			case "hash":
				os.WriteFile(local, []byte("повреждение"), 0600)
			case "space":
				m.installOptions.freeSpace = func(string) (uint64, error) { return 1, nil }
			case "write":
				m.installOptions.freeSpace = func(string) (uint64, error) { return 0, os.ErrPermission }
			case "rename":
				m.installOptions.rename = func(string, string) error { return os.ErrPermission }
			case "cancel":
				cancelled, cancel := context.WithCancel(ctx)
				cancel()
				ctx = cancelled
			}
			result, err := m.Install(ctx, request)
			if err == nil {
				t.Fatal("ожидался отказ")
			}
			if kind == "cancel" && result.Status != "cancelled" {
				t.Fatalf("%+v", result)
			}
			current, _ := os.ReadFile(filepath.Join(root, a.ID, "active.json"))
			if !bytes.Equal(current, pointer) {
				t.Fatal("изменён active при отказе")
			}
			previous, err := os.ReadFile(filepath.Join(old, "vocals.onnx"))
			if err != nil || !bytes.Equal(previous, data) {
				t.Fatal("повреждена предыдущая установка")
			}
		})
	}
}

func TestInstallResumeAcrossRestart(t *testing.T) {
	m, a, data := installationFixture(t)
	var calls atomic.Int32
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		w.Header().Set("ETag", `"revision-1"`)
		if n == 1 {
			w.Header().Set("Content-Length", fmt.Sprint(len(data)))
			w.Write(data[:8])
			return
		}
		if r.Header.Get("Range") != "bytes=8-" || r.Header.Get("If-Range") != `"revision-1"` {
			t.Errorf("нет докачки: %+v", r.Header)
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 8-%d/%d", len(data)-1, len(data)))
		w.WriteHeader(http.StatusPartialContent)
		w.Write(data[8:])
	}))
	defer server.Close()
	m.manifest.Artifacts[0].URL = server.URL
	a.URL = server.URL
	request := InstallRequest{Components: []string{"voc-ft"}}
	if _, err := m.Install(context.Background(), request); err == nil {
		t.Fatal("обрыв не распознан")
	}
	restarted := newManager(m.profile, m.manifest, m.options)
	if _, err := restarted.Install(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("requests %d", calls.Load())
	}
}

func TestInstallUnconfirmedRangeRestarts(t *testing.T) {
	for _, mode := range []string{"ignored", "changed-etag", "wrong-range"} {
		t.Run(mode, func(t *testing.T) {
			m, _, data := installationFixture(t)
			var calls atomic.Int32
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				n := calls.Add(1)
				w.Header().Set("ETag", `"v1"`)
				if n == 1 {
					w.Header().Set("Content-Length", fmt.Sprint(len(data)))
					w.Write(data[:8])
					return
				}
				if n == 2 && mode != "ignored" {
					w.Header().Set("Content-Range", fmt.Sprintf("bytes 8-%d/%d", len(data)-1, len(data)))
					if mode == "changed-etag" {
						w.Header().Set("ETag", `"v2"`)
					} else {
						w.Header().Set("Content-Range", "bytes 1-2/3")
					}
					w.WriteHeader(206)
					w.Write(data[8:])
					return
				}
				if n == 3 && r.Header.Get("Range") != "" {
					t.Error("повтор должен быть полным")
				}
				w.Write(data)
			}))
			defer server.Close()
			m.manifest.Artifacts[0].URL = server.URL
			request := InstallRequest{Components: []string{"voc-ft"}}
			m.Install(context.Background(), request)
			if _, err := m.Install(context.Background(), request); err != nil {
				t.Fatal(err)
			}
		})
	}
}

func TestInstallCancelAndSerialize(t *testing.T) {
	m, _, data := installationFixture(t)
	started := make(chan struct{})
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		close(started)
		w.Header().Set("Content-Length", fmt.Sprint(len(data)))
		w.Header().Set("ETag", `"v1"`)
		w.WriteHeader(200)
		w.(http.Flusher).Flush()
		<-r.Context().Done()
	}))
	defer server.Close()
	m.manifest.Artifacts[0].URL = server.URL
	done := make(chan error, 1)
	go func() {
		_, err := m.Install(context.Background(), InstallRequest{Components: []string{"voc-ft"}})
		done <- err
	}()
	<-started
	if _, err := m.Configure(Selection{}); err == nil {
		t.Fatal("Configure пересёк установку")
	}
	if _, err := m.Check(context.Background(), nil, false); err == nil {
		t.Fatal("Check пересёк установку")
	}
	m.CancelInstall()
	if err := <-done; err == nil {
		t.Fatal("отмена проигнорирована")
	}
	if m.Installation().Status != "cancelled" {
		t.Fatalf("%+v", m.Installation())
	}
}

func TestInstallInterruptedStateAndPointer(t *testing.T) {
	m, a, _ := installationFixture(t)
	m.installUpdate("downloading", "voc-ft", 5, 10, "Загрузка.")
	restarted := newManager(m.profile, m.manifest, m.options)
	if restarted.Installation().Status != "cancelled" {
		t.Fatal("перезапуск не объяснён")
	}
	base := filepath.Join(m.profile, "components", a.ID)
	os.MkdirAll(base, 0700)
	data, _ := json.Marshal(activeInstallation{Version: a.Version, Directory: "../../чужой каталог"})
	os.WriteFile(filepath.Join(base, "active.json"), data, 0600)
	if got := managedArtifactDirectory(filepath.Join(m.profile, "components"), a); got != base {
		t.Fatalf("небезопасный pointer: %s", got)
	}
}

// archiveFixture покрывает одинаковый устанавливаемый состав ZIP/tgz/xz и опасные записи tar.
func archiveFixture(t *testing.T, format string, malicious bool) ([]byte, Artifact) {
	t.Helper()
	payload := []byte("binary")
	sum := sha256.Sum256(payload)
	a := Artifact{Root: "package", Format: format, UnpackedBytes: 1000, Files: []File{{Path: "bin/tool", Type: "file", Bytes: int64(len(payload)), SHA256: hex.EncodeToString(sum[:])}, {Path: "LICENSE", Type: "file", Bytes: 7}, {Path: "lib/link", Type: "symlink", Target: "../bin/tool"}}, Preserve: []string{"doc/**"}}
	var buffer bytes.Buffer
	if format == "zip" {
		z := zip.NewWriter(&buffer)
		for _, name := range []string{"package/bin/tool", "package/LICENSE", "package/doc/readme"} {
			f, _ := z.Create(name)
			f.Write(payload)
		}
		z.Close()
		return buffer.Bytes(), a
	}
	var writer io.WriteCloser
	if format == "tar.gz" {
		writer = gzip.NewWriter(&buffer)
	} else {
		var err error
		writer, err = xz.NewWriter(&buffer)
		if err != nil {
			t.Fatal(err)
		}
	}
	tw := tar.NewWriter(writer)
	for _, name := range []string{"package/bin/tool", "package/LICENSE", "package/doc/readme", "package/ignored"} {
		if malicious && strings.Contains(name, "ignored") {
			name = "package/../../outside"
		}
		tw.WriteHeader(&tar.Header{Name: name, Mode: 0755, Typeflag: tar.TypeReg, Size: int64(len(payload))})
		tw.Write(payload)
	}
	tw.WriteHeader(&tar.Header{Name: "package/lib/link", Typeflag: tar.TypeSymlink, Linkname: "../bin/tool"})
	tw.Close()
	writer.Close()
	return buffer.Bytes(), a
}

func TestExtractFormatsAndTraversal(t *testing.T) {
	for _, format := range []string{"tar.gz", "tar.xz", "zip"} {
		t.Run(format, func(t *testing.T) {
			data, a := archiveFixture(t, format, false)
			directory := t.TempDir()
			err := extractArtifact(context.Background(), offlinePayload(t, data), directory, a)
			if err != nil {
				t.Fatal(err)
			}
			if format == "zip" {
				if _, err = os.Stat(filepath.Join(directory, "doc/readme")); err != nil {
					t.Fatal(err)
				}
			}
			if _, err = os.Stat(filepath.Join(directory, "ignored")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("лишний файл установлен")
			}
		})
	}
	data, a := archiveFixture(t, "tar.gz", true)
	if err := extractArtifact(context.Background(), offlinePayload(t, data), t.TempDir(), a); err == nil {
		t.Fatal("traversal принят")
	}
}

func TestExtractExpectedSafeSymlink(t *testing.T) {
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	tw := tar.NewWriter(gz)
	tw.WriteHeader(&tar.Header{Name: "root/lib/runtime.so", Mode: 0755, Size: 1, Typeflag: tar.TypeReg})
	tw.Write([]byte{1})
	tw.WriteHeader(&tar.Header{Name: "root/lib/runtime", Linkname: "runtime.so", Typeflag: tar.TypeSymlink})
	tw.Close()
	gz.Close()
	a := Artifact{Format: "tar.gz", Root: "root", UnpackedBytes: 1, Files: []File{{Path: "lib/runtime.so", Type: "file"}, {Path: "lib/runtime", Type: "symlink", Target: "runtime.so"}}}
	directory := t.TempDir()
	if err := extractArtifact(context.Background(), offlinePayload(t, buffer.Bytes()), directory, a); err != nil {
		t.Fatal(err)
	}
	if got, _ := os.Readlink(filepath.Join(directory, "lib/runtime")); got != "runtime.so" {
		t.Fatalf("link %q", got)
	}
}

// TestInstallNativeOffline использует реальные read-only архив/словарь только по явному env разработчика.
// Профиль и установленная копия временные; сеть и ONNX inference здесь не вызываются.
func TestInstallNativeOffline(t *testing.T) {
	ortArchive, vocab := os.Getenv("SONGFRAME_TEST_OFFLINE_ORT"), os.Getenv("SONGFRAME_TEST_OFFLINE_VOCAB")
	if ortArchive == "" || vocab == "" {
		t.Skip("нужны SONGFRAME_TEST_OFFLINE_ORT и SONGFRAME_TEST_OFFLINE_VOCAB")
	}
	m, err := NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	request := InstallRequest{Components: []string{"ort-cpu", "ctc-vocab"}, LocalFiles: map[string]string{"ort-cpu": ortArchive, "ctc-vocab": vocab}}
	if _, err = m.Install(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	restarted, err := NewManager(m.profile)
	if err != nil {
		t.Fatal(err)
	}
	restarted.mu.Lock()
	candidates := restarted.discover()
	restarted.mu.Unlock()
	found := 0
	for _, c := range candidates {
		if c.state.ID != "ort-cpu" && c.state.ID != "ctc-vocab" {
			continue
		}
		if c.state.Source != "managed" || c.state.Status != "unchecked" {
			t.Fatalf("%+v", c.state)
		}
		if err = restarted.verifyFiles(context.Background(), c, true); err != nil {
			t.Fatal(err)
		}
		if c.state.ID == "ctc-vocab" {
			if err = verifyVocab(c.state.Paths["vocab"]); err != nil {
				t.Fatal(err)
			}
		}
		found++
	}
	if found != 2 {
		t.Fatalf("найдено %d компонентов", found)
	}
}

func TestInstallReusesUncheckedModelWithoutNetwork(t *testing.T) {
	m, _, data := installationFixture(t)
	local := offlinePayload(t, data)
	if _, err := m.Configure(Selection{VocalsFile: local}); err != nil {
		t.Fatal(err)
	}
	request := InstallRequest{Components: []string{"voc-ft"}}
	if _, err := m.Install(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	// Выбранный файл уже подходит, поэтому URL даже не задан и сеть не нужна.
	if m.State().Components[2].Source != "explicit" {
		t.Fatal("явный путь потерян")
	}
	os.Remove(local)
	if _, err := m.Install(context.Background(), request); err == nil {
		t.Fatal("исчезнувший явный путь нельзя обходить загрузкой")
	}
}

func TestInstallReusesUncheckedPATHWithoutNetwork(t *testing.T) {
	m, _, _ := installationFixture(t)
	dir := t.TempDir()
	for _, role := range []string{"ffmpeg", "ffprobe"} {
		os.WriteFile(filepath.Join(dir, role), []byte(role), 0700)
	}
	m.manifest.Artifacts = append(m.manifest.Artifacts, Artifact{ID: "ffmpeg-linux", Component: "ffmpeg", Version: "test", OS: "linux", Arch: "amd64", Entrypoints: map[string]string{"ffmpeg": "bin/ffmpeg", "ffprobe": "bin/ffprobe"}})
	m.manifest.Capabilities = []Capability{{ID: "audio-pcm", Requires: []string{"ffmpeg"}}}
	m.options.lookPath = func(role string) (string, error) { return filepath.Join(dir, role), nil }
	m.options.media = func(context.Context, Manifest, FFmpegPair) (MediaReport, error) {
		return MediaReport{Version: "test", Operations: map[string]ProbeOutcome{"audio-pcm": {Status: "ready"}}}, nil
	}
	if _, err := m.Install(context.Background(), InstallRequest{Components: []string{"ffmpeg"}}); err != nil {
		t.Fatal(err)
	}
	if state := m.State().Components[0]; state.Source != "path" || state.Status != "ready" {
		t.Fatalf("%+v", state)
	}
}

func TestInstallWriteDeniedAndCancelledHashPreservesCache(t *testing.T) {
	m, a, data := installationFixture(t)
	rootFile := offlinePayload(t, []byte("файл вместо папки"))
	if _, err := m.Configure(Selection{ManagedDirectory: rootFile}); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Install(context.Background(), InstallRequest{Components: []string{"voc-ft"}, LocalFiles: map[string]string{"voc-ft": offlinePayload(t, data)}}); err == nil {
		t.Fatal("запись в файл вместо папки разрешена")
	}
	// Отмена локальной проверки не изменяет ни внешний файл, ни полную копию загрузки.
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	source := offlinePayload(t, data)
	if err := verifyPayload(ctx, source, a.Bytes, a.SHA256); !errors.Is(err, context.Canceled) {
		t.Fatalf("%v", err)
	}
	if got, _ := os.ReadFile(source); !bytes.Equal(got, data) {
		t.Fatal("полезная копия удалена")
	}
}

func TestInstallOfflineDoesNotSkipReady(t *testing.T) {
	m, a, data := installationFixture(t)
	local := offlinePayload(t, data)
	request := InstallRequest{Components: []string{"voc-ft"}, LocalFiles: map[string]string{"voc-ft": local}}
	if _, err := m.Install(context.Background(), request); err != nil {
		t.Fatal(err)
	}
	m.mu.Lock()
	for _, c := range m.discover() {
		if c.state.ID == "voc-ft" {
			m.checked[c.state.ID] = checkedState{signature: c.signature, status: "ready"}
		}
	}
	m.mu.Unlock()
	previous := managedArtifactDirectory(filepath.Join(m.profile, "components"), a)
	os.WriteFile(local, []byte("неверный файл"), 0600)
	if _, err := m.Install(context.Background(), request); err == nil {
		t.Fatal("SHA явного офлайн-файла не проверен")
	}
	if managedArtifactDirectory(filepath.Join(m.profile, "components"), a) != previous {
		t.Fatal("активный путь изменился")
	}
}
