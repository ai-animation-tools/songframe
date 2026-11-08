package components

import (
	"archive/tar"
	"bytes"
	"compress/gzip"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"testing"
)

// archiveForComponent создаёт маленький корректный архив из синтетического закреплённого runtime.
// Реальные веса/архивы и сетевые адреса в этих автономных сценариях не используются.
func archiveForComponent(t *testing.T, m *Manager, id string) string {
	t.Helper()
	root := installSynthetic(t, m, id)
	a, ok := m.artifact(id)
	if !ok {
		t.Fatal("нет artifact")
	}
	var buffer bytes.Buffer
	gz := gzip.NewWriter(&buffer)
	tw := tar.NewWriter(gz)
	var unpacked int64
	for _, file := range a.Files {
		name := filepath.Join(root, filepath.FromSlash(file.Path))
		header := &tar.Header{Name: a.Root + "/" + file.Path, Mode: 0700, Typeflag: tar.TypeReg}
		if file.Type == "symlink" {
			header.Typeflag = tar.TypeSymlink
			header.Linkname = file.Target
			if err := tw.WriteHeader(header); err != nil {
				t.Fatal(err)
			}
			continue
		}
		data, err := os.ReadFile(name)
		if err != nil {
			t.Fatal(err)
		}
		header.Size = int64(len(data))
		unpacked += header.Size
		if err = tw.WriteHeader(header); err != nil {
			t.Fatal(err)
		}
		if _, err = tw.Write(data); err != nil {
			t.Fatal(err)
		}
	}
	if err := tw.Close(); err != nil {
		t.Fatal(err)
	}
	if err := gz.Close(); err != nil {
		t.Fatal(err)
	}
	sum := sha256.Sum256(buffer.Bytes())
	for i := range m.manifest.Artifacts {
		if m.manifest.Artifacts[i].ID == a.ID {
			m.manifest.Artifacts[i].Format = "tar.gz"
			m.manifest.Artifacts[i].Bytes = int64(buffer.Len())
			m.manifest.Artifacts[i].UnpackedBytes = unpacked
			m.manifest.Artifacts[i].InstallBytes = unpacked
			m.manifest.Artifacts[i].SHA256 = hex.EncodeToString(sum[:])
		}
	}
	if err := os.RemoveAll(root); err != nil {
		t.Fatal(err)
	}
	return offlinePayload(t, buffer.Bytes())
}

// TestConnectReadyFilesReuseWithoutCopy подключает готовые реальные пути, оставляя проверку готовности штатному Check.
// Выбор произвольно названного runtime не требует root/lib и не создаёт копии модели в managed.
func TestConnectReadyFilesReuseWithoutCopy(t *testing.T) {
	m, media, native := testManager(t)
	vocRoot := installSynthetic(t, m, "voc-ft")
	model := filepath.Join(t.TempDir(), "Выбранная готовая модель.onnx")
	modelBytes, copyErr := os.ReadFile(filepath.Join(vocRoot, "vocals.onnx"))
	if copyErr != nil {
		t.Fatal(copyErr)
	}
	if copyErr = os.WriteFile(model, modelBytes, 0600); copyErr != nil {
		t.Fatal(copyErr)
	}
	beforeManaged, copyErr := os.ReadDir(filepath.Dir(vocRoot))
	if copyErr != nil {
		t.Fatal(copyErr)
	}
	pair := externalPair(t)
	runtimeRoot, library := explicitORTLibrary(t, m)
	renamed := filepath.Join(runtimeRoot, "Совместимый runtime без знания имени")
	data, err := os.ReadFile(library)
	if err != nil {
		t.Fatal(err)
	}
	if err = os.WriteFile(renamed, data, 0700); err != nil {
		t.Fatal(err)
	}
	for _, choice := range []struct{ id, path string }{{"ffmpeg", filepath.Join(pair, "ffprobe")}, {"ort-cpu", renamed}, {"voc-ft", model}} {
		if _, err = m.Connect(context.Background(), choice.id, choice.path); err != nil {
			t.Fatal(err)
		}
	}
	state, err := m.Check(context.Background(), []string{"prepare-vocals"}, false)
	if err != nil || *media != 1 || *native != 1 || operation(t, state, "prepare-vocals").Status != "ready" {
		t.Fatalf("%v %+v", err, state)
	}
	if component(t, state, "voc-ft").Paths["model"] != model || component(t, state, "ort-cpu").Paths["ort-library"] != renamed {
		t.Fatal("готовые файлы перемещены или перенастроены")
	}
	if state.Selection.ORTLibraryFile != renamed || state.Selection.ORTDirectory != "" || state.Selection.VocalsFile != model {
		t.Fatalf("%+v", state.Selection)
	}
	afterManaged, readErr := os.ReadDir(filepath.Dir(vocRoot))
	if readErr != nil || len(afterManaged) != len(beforeManaged) {
		t.Fatal("модель скопирована в managed")
	}
}

// TestConnectDirectoriesNormalizesFiles сохраняет script/API поддержку папок без второго пользовательского режима.
// Корень FFmpeg и lib/ ORT преобразуются в пригодные effective paths.
func TestConnectDirectoriesNormalizesFiles(t *testing.T) {
	m, _, _ := testManager(t)
	pair := externalPair(t)
	ffmpegRoot := t.TempDir()
	if err := os.Rename(pair, filepath.Join(ffmpegRoot, "bin")); err != nil {
		t.Fatal(err)
	}
	runtimeRoot, library := explicitORTLibrary(t, m)
	if _, err := m.Connect(context.Background(), "ffmpeg", ffmpegRoot); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Connect(context.Background(), "ort-cpu", filepath.Join(runtimeRoot, "lib")); err != nil {
		t.Fatal(err)
	}
	state := m.State()
	if state.Selection.FFmpegDirectory != filepath.Join(ffmpegRoot, "bin") || state.Selection.ORTLibraryFile != library {
		t.Fatalf("%+v", state.Selection)
	}
	missing := t.TempDir()
	before := state.Selection
	if _, err := m.Connect(context.Background(), "ort-cpu", missing); err == nil {
		t.Fatal("пустая папка принята")
	}
	if m.State().Selection != before {
		t.Fatal("ошибка выбора папки изменила старый путь")
	}
}

// TestConnectCTCFilesAreIndependent меняет только выбранную карточку при общем legacy-корне моделей.
// Путь и состояние соседнего компонента остаются прежними, пока его явно не выбрали.
func TestConnectCTCFilesAreIndependent(t *testing.T) {
	m, _, _, selection := explicitCachedManager(t)
	original := m.State()
	vocabBefore := component(t, original, "ctc-vocab")
	model := filepath.Join(t.TempDir(), "Отдельно выбранная модель.onnx")
	data, err := os.ReadFile(component(t, original, "ctc-ru").Paths["model"])
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(model, data, 0600)
	if _, err = m.Connect(context.Background(), "ctc-ru", model); err != nil {
		t.Fatal(err)
	}
	state := m.State()
	if state.Selection.CTCDirectory != selection.CTCDirectory || state.Selection.CTCModelFile != model || !reflect.DeepEqual(component(t, state, "ctc-vocab"), vocabBefore) {
		t.Fatal("выбор модели перенастроил словарь")
	}
	vocab := filepath.Join(t.TempDir(), "Отдельный словарь.json")
	data, err = os.ReadFile(vocabBefore.Paths["vocab"])
	if err != nil {
		t.Fatal(err)
	}
	os.WriteFile(vocab, data, 0600)
	if _, err = m.Connect(context.Background(), "ctc-vocab", vocab); err != nil {
		t.Fatal(err)
	}
	state = m.State()
	if state.Selection.CTCModelFile != model || component(t, state, "ctc-ru").Paths["model"] != model || component(t, state, "ctc-vocab").Paths["vocab"] != vocab {
		t.Fatal("выбор словаря перенастроил модель")
	}
	if _, err = m.Check(context.Background(), []string{"ctc-existing-vocals"}, false); err != nil {
		t.Fatal(err)
	}
}

// TestConnectArchivePublishesThenRetargets переключает только выбранный runtime после SHA/staging успешного архива.
// Неудачный архив сохраняет старый внешний путь и прежний managed active.
func TestConnectArchivePublishesThenRetargets(t *testing.T) {
	m, _, _ := testManager(t)
	archive := archiveForComponent(t, m, "ort-cpu")
	root, library := explicitORTLibrary(t, m)
	if _, err := m.Configure(Selection{ORTDirectory: root, ORTLibraryFile: library, VocalsFile: "не менять модель"}); err != nil {
		t.Fatal(err)
	}
	before := m.State().Selection
	bad := offlinePayload(t, []byte{0x1f, 0x8b, 0, 1, 2, 3})
	if _, err := m.Connect(context.Background(), "ort-cpu", bad); err == nil {
		t.Fatal("архив с неверным SHA принят")
	}
	if m.State().Selection != before {
		t.Fatal("ошибка импорта потеряла прежнее подключение")
	}
	if _, err := m.Connect(context.Background(), "ort-cpu", archive); err != nil {
		t.Fatal(err)
	}
	state := m.State()
	runtime := component(t, state, "ort-cpu")
	if runtime.Source != "managed" || state.Selection.ORTDirectory != "" || state.Selection.ORTLibraryFile != "" || state.Selection.VocalsFile != before.VocalsFile {
		t.Fatalf("неадресный retarget: %+v", state)
	}
	if _, err := os.Stat(library); err != nil {
		t.Fatal("внешняя библиотека удалена")
	}
	_, _ = m.Check(context.Background(), []string{"prepare-vocals"}, false)
	if component(t, m.State(), "ort-cpu").Status != "ready" {
		t.Fatal("опубликованный runtime не дошёл до native ready")
	}
}

// TestDownloadReusesManagedAndPreservesCTCNeighbor подключает уже скачанный набор вместо неисправного внешнего файла без новой сети.
// Освобождение общего CTC-корня сохраняет effective path и готовность соседней карточки.
func TestDownloadReusesManagedAndPreservesCTCNeighbor(t *testing.T) {
	for _, selected := range []string{"ctc-ru", "ctc-vocab"} {
		t.Run(selected, func(t *testing.T) {
			m, _, _, selection := explicitCachedManager(t)
			installSynthetic(t, m, selected)
			original := m.State()
			neighbor := "ctc-vocab"
			if selected == "ctc-vocab" {
				neighbor = "ctc-ru"
			}
			before := component(t, original, neighbor)
			for i := range m.manifest.Artifacts {
				if m.manifest.Artifacts[i].Component == selected {
					m.manifest.Artifacts[i].URL = "сеть не должна вызываться"
				}
			}
			// Общий путь для выбранного компонента становится непригодным, но соседний файл остаётся на месте.
			selectedPath := component(t, original, selected).Paths["model"]
			if selected == "ctc-vocab" {
				selectedPath = component(t, original, selected).Paths["vocab"]
			}
			os.Remove(selectedPath)
			result, err := m.Download(context.Background(), []string{selected})
			if err != nil || result.Status != "installed" {
				t.Fatalf("%+v %v", result, err)
			}
			state := m.State()
			if component(t, state, selected).Source != "managed" || state.Selection.CTCDirectory != "" {
				t.Fatalf("не выбран managed: %+v", state)
			}
			if !reflect.DeepEqual(component(t, state, neighbor), before) {
				t.Fatalf("сосед изменён: before=%+v after=%+v", before, component(t, state, neighbor))
			}
			if selected == "ctc-ru" && state.Selection.CTCVocabFile != filepath.Join(selection.CTCDirectory, "vocab.json") {
				t.Fatal("потерян путь словаря")
			}
			if selected == "ctc-vocab" && state.Selection.CTCModelFile != filepath.Join(selection.CTCDirectory, "alignment.onnx") {
				t.Fatal("потерян путь модели")
			}
		})
	}
}

// TestHTTPExpectedSizeAndSHA различает закреплённый размер пакета и необязательное заявление HTTP-сервера.
// Неизвестная длина разрешена только с фактическим byte-limit и финальной проверкой SHA.
func TestHTTPExpectedSizeAndSHA(t *testing.T) {
	for _, mode := range []string{"known-mismatch", "unknown-good", "unknown-bad-sha"} {
		t.Run(mode, func(t *testing.T) {
			m, _, data := installationFixture(t)
			server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if mode == "known-mismatch" {
					w.Header().Set("Content-Length", fmt.Sprint(len(data)-1))
					w.Write(data[:len(data)-1])
					return
				}
				w.(http.Flusher).Flush()
				payload := append([]byte{}, data...)
				if mode == "unknown-bad-sha" {
					payload[0] ^= 1
				}
				w.Write(payload)
			}))
			defer server.Close()
			m.manifest.Artifacts[0].URL = server.URL
			result, err := m.Download(context.Background(), []string{"voc-ft"})
			if mode == "unknown-good" {
				if err != nil || result.Status != "installed" {
					t.Fatalf("%v %+v", err, result)
				}
			} else if err == nil || result.Status != "error" {
				t.Fatalf("ошибочный размер/SHA принят: %v %+v", err, result)
			}
		})
	}
}

// TestHTTPSizeMismatchPreservesPartial сохраняет подтверждённую часть, если ответ докачки объявил неверную длину.
// До согласования Content-Length установщик не обнуляет файл и не меняет его ETag metadata.
func TestHTTPSizeMismatchPreservesPartial(t *testing.T) {
	m, a, data := installationFixture(t)
	requests := 0
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		requests++
		w.Header().Set("ETag", `"same-revision"`)
		if requests == 1 {
			w.Header().Set("Content-Length", fmt.Sprint(len(data)))
			w.Write(data[:8])
			return
		}
		if r.Header.Get("Range") != "bytes=8-" {
			t.Error("нет ожидаемого Range")
		}
		w.Header().Set("Content-Range", fmt.Sprintf("bytes 8-%d/%d", len(data)-1, len(data)))
		w.Header().Set("Content-Length", fmt.Sprint(len(data)-9))
		w.WriteHeader(http.StatusPartialContent)
		w.Write(data[8 : len(data)-1])
	}))
	defer server.Close()
	m.manifest.Artifacts[0].URL = server.URL
	if _, err := m.Download(context.Background(), []string{"voc-ft"}); err == nil {
		t.Fatal("не распознан обрыв")
	}
	cache := filepath.Join(m.profile, "components", ".downloads", a.ID+"-"+a.SHA256+".part")
	before, err := os.ReadFile(cache)
	if err != nil {
		t.Fatal(err)
	}
	metadata, err := os.ReadFile(cache + ".json")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = m.Download(context.Background(), []string{"voc-ft"}); err == nil {
		t.Fatal("неверный Content-Length принят")
	}
	after, _ := os.ReadFile(cache)
	afterMetadata, _ := os.ReadFile(cache + ".json")
	if !bytes.Equal(before, after) || !bytes.Equal(metadata, afterMetadata) || len(after) != 8 {
		t.Fatal("неверная длина сервера изменила полезный кэш")
	}
}

// TestConnectSameArchiveKeepsNativeIdentity не переустанавливает уже пригодный runtime при повторном выборе того же архива.
// Источник снова проверяется, но generation/path остаются прежними и новый native Init не требуется.
func TestConnectSameArchiveKeepsNativeIdentity(t *testing.T) {
	m, _, native := testManager(t)
	archive := archiveForComponent(t, m, "ort-cpu")
	if _, err := m.Connect(context.Background(), "ort-cpu", archive); err != nil {
		t.Fatal(err)
	}
	_, _ = m.Check(context.Background(), []string{"prepare-vocals"}, false)
	original := component(t, m.State(), "ort-cpu")
	if original.Status != "ready" || *native != 1 {
		t.Fatalf("%+v native=%d", original, *native)
	}
	if _, err := m.Connect(context.Background(), "ort-cpu", archive); err != nil {
		t.Fatal(err)
	}
	_, _ = m.Check(context.Background(), []string{"prepare-vocals"}, false)
	if current := component(t, m.State(), "ort-cpu"); !reflect.DeepEqual(current, original) || *native != 1 {
		t.Fatalf("повторный архив изменил native identity: %+v native=%d", current, *native)
	}
	bad := offlinePayload(t, []byte{0x1f, 0x8b, 0, 1, 2, 3})
	if _, err := m.Connect(context.Background(), "ort-cpu", bad); err == nil {
		t.Fatal("ошибочный выбранный архив проигнорирован")
	}
	if !reflect.DeepEqual(component(t, m.State(), "ort-cpu"), original) {
		t.Fatal("ошибка повторного импорта изменила пригодный runtime")
	}
}
