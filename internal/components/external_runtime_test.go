package components

import (
	"context"
	"errors"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

// explicitORTLibrary создаёт только рабочий entrypoint без архива, notices и aliases.
// Произвольные тестовые байты принимаются исключительно подменённой native-границей.
func explicitORTLibrary(t *testing.T, m *Manager) (string, string) {
	t.Helper()
	artifact, ok := m.artifact("ort-cpu")
	if !ok {
		t.Fatal("нет тестового ORT artifact")
	}
	root := filepath.Join(t.TempDir(), "Внешний runtime с пробелами")
	library := filepath.Join(root, filepath.FromSlash(artifact.Entrypoints["ort-library"]))
	if err := os.MkdirAll(filepath.Dir(library), 0700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(library, []byte("внешняя сборка имеет собственные байты"), 0700); err != nil {
		t.Fatal(err)
	}
	return root, library
}

// TestManagerWrongORTFolderNamesLibraryFirst воспроизводит выбор FFmpeg bin в поле внешнего ORT.
// Повторный опрос не должен менять путь или объяснять отсутствие runtime через LICENSE.
func TestManagerWrongORTFolderNamesLibraryFirst(t *testing.T) {
	m, media, native := testManager(t)
	pair := externalPair(t)
	m.options.lookPath = func(role string) (string, error) { return filepath.Join(pair, role), nil }
	if _, err := m.Configure(Selection{ORTDirectory: pair}); err != nil {
		t.Fatal(err)
	}
	initial := component(t, m.State(), "ort-cpu")
	if initial.Status != "missing" || !strings.Contains(initial.Reason, "Не найдена библиотека ONNX Runtime:") || strings.Contains(initial.Reason, "LICENSE") {
		t.Fatalf("%+v", initial)
	}
	for i := 0; i < 30; i++ {
		if got := component(t, m.State(), "ort-cpu"); !reflect.DeepEqual(got, initial) {
			t.Fatalf("нестабильный snapshot: %+v %+v", initial, got)
		}
	}
	snapshot, err := m.Check(context.Background(), []string{"prepare-vocals"}, false)
	if err == nil || *native != 0 || *media != 1 || component(t, snapshot, "ffmpeg").Status != "ready" {
		t.Fatalf("native=%d media=%d error=%v state=%+v", *native, *media, err, snapshot)
	}
	if !reflect.DeepEqual(component(t, snapshot, "ort-cpu").Paths, initial.Paths) || snapshot.Selection.ORTDirectory != pair {
		t.Fatal("проверка изменила выбранный путь")
	}
}

// TestManagerOperationalEntrypointsPrecedeDocuments проверяет одинаковую причину для всех источников.
// При отсутствии runtime и notices managed сообщает прежде всего рабочую библиотеку.
func TestManagerOperationalEntrypointsPrecedeDocuments(t *testing.T) {
	m, _, _ := testManager(t)
	initial := component(t, m.State(), "ort-cpu")
	if !strings.Contains(initial.Reason, "Не найдена библиотека ONNX Runtime:") {
		t.Fatalf("%+v", initial)
	}
	for i := 0; i < 30; i++ {
		if got := component(t, m.State(), "ort-cpu"); got.Reason != initial.Reason || !reflect.DeepEqual(got.Paths, initial.Paths) {
			t.Fatalf("нестабильная причина: %+v", got)
		}
	}
	a, _ := m.artifact("ffmpeg")
	c := candidate{artifact: a, state: ComponentState{Paths: map[string]string{"ffmpeg": "/binary/ffmpeg", "ffprobe": "/binary/ffprobe"}}, files: map[string]string{"LICENSE": "/docs/LICENSE", "ffmpeg": "/binary/ffmpeg", "ffprobe": "/binary/ffprobe", "doc/z": "/docs/z"}}
	if got := candidateFileOrder(c); !reflect.DeepEqual(got, []string{"ffmpeg", "ffprobe", "LICENSE", "doc/z"}) {
		t.Fatalf("порядок %v", got)
	}
}

// TestManagerExplicitORTUsesNativeContract допускает внешний рабочий runtime без файлов дистрибутива.
// Пригодность приходит только от native probe; путь и semantic version сохраняются в снимке.
func TestManagerExplicitORTUsesNativeContract(t *testing.T) {
	m, _, native := testManager(t)
	installSynthetic(t, m, "ffmpeg")
	installSynthetic(t, m, "voc-ft")
	root, library := explicitORTLibrary(t, m)
	original := m.options.ort
	m.options.ort = func(ctx context.Context, path string, models []ModelFile) (ORTReport, error) {
		if path != library {
			t.Fatalf("подменён путь %q", path)
		}
		report, err := original(ctx, path, models)
		report.Version = "совместимая внешняя версия"
		return report, err
	}
	if _, err := m.Configure(Selection{ORTDirectory: root}); err != nil {
		t.Fatal(err)
	}
	initial := component(t, m.State(), "ort-cpu")
	if initial.Status != "unchecked" {
		t.Fatalf("%+v", initial)
	}
	snapshot, err := m.Check(context.Background(), []string{"prepare-vocals"}, false)
	runtime := component(t, snapshot, "ort-cpu")
	if err != nil || *native != 1 || runtime.Status != "ready" || runtime.Source != "explicit" || runtime.Version != "совместимая внешняя версия" || runtime.Paths["ort-library"] != library {
		t.Fatalf("%+v %v native=%d", runtime, err, *native)
	}
	for i := 0; i < 30; i++ {
		if got := component(t, m.State(), "ort-cpu"); !reflect.DeepEqual(got, runtime) {
			t.Fatalf("сменился path/status: %+v", got)
		}
	}
}

// TestManagerManagedORTStillRequiresIntegrity сохраняет SHA/notices/aliases управляемой поставки.
// Ошибочные bytes или неполный состав не должны доходить до native loader.
func TestManagerManagedORTStillRequiresIntegrity(t *testing.T) {
	for _, broken := range []string{"library-sha", "notice-sha", "notice-missing", "alias-missing"} {
		t.Run(broken, func(t *testing.T) {
			m, _, native := testManager(t)
			root := installSynthetic(t, m, "ort-cpu")
			a, _ := m.artifact("ort-cpu")
			switch broken {
			case "library-sha":
				os.WriteFile(filepath.Join(root, filepath.FromSlash(a.Entrypoints["ort-library"])), []byte("повреждённая библиотека"), 0700)
			case "notice-sha":
				os.WriteFile(filepath.Join(root, "ThirdPartyNotices.txt"), []byte("повреждение notices"), 0600)
			case "notice-missing":
				os.Remove(filepath.Join(root, "LICENSE"))
			case "alias-missing":
				os.Remove(filepath.Join(root, "lib", "libonnxruntime.so"))
			}
			snapshot, err := m.Check(context.Background(), []string{"prepare-vocals"}, true)
			if err == nil || *native != 0 || component(t, snapshot, "ort-cpu").Status == "ready" {
				t.Fatalf("managed integrity ослаблена: %v %+v native=%d", err, snapshot, *native)
			}
		})
	}
}

// TestInstallExplicitORTNativeReuse избегает повторной сети только для пригодной внешней библиотеки.
// Отказ ABI и требование перезапуска не подменяются успешным installed.
func TestInstallExplicitORTNativeReuse(t *testing.T) {
	for _, mode := range []string{"compatible", "bad-abi", "restart"} {
		t.Run(mode, func(t *testing.T) {
			m, _, native := testManager(t)
			root, library := explicitORTLibrary(t, m)
			if _, err := m.Configure(Selection{ORTDirectory: root}); err != nil {
				t.Fatal(err)
			}
			for i := range m.manifest.Artifacts {
				if m.manifest.Artifacts[i].Component == "ort-cpu" {
					m.manifest.Artifacts[i].URL = "не должен использоваться"
				}
			}
			original := m.options.ort
			m.options.ort = func(ctx context.Context, path string, models []ModelFile) (ORTReport, error) {
				if path != library {
					t.Fatal("сменился path")
				}
				if mode != "compatible" {
					*native++
					return ORTReport{RestartRequired: mode == "restart"}, errors.New("native probe отклонил runtime")
				}
				return original(ctx, path, models)
			}
			result, err := m.Install(context.Background(), InstallRequest{Components: []string{"ort-cpu"}})
			runtime := component(t, m.State(), "ort-cpu")
			if mode == "compatible" {
				if err != nil || result.Status != "installed" || runtime.Status != "ready" || *native != 1 {
					t.Fatalf("%+v %+v %v native=%d", result, runtime, err, *native)
				}
			} else {
				expected := "incompatible"
				if mode == "restart" {
					expected = "restart_required"
				}
				if err == nil || result.Status != "error" || runtime.Status != expected || *native != 1 {
					t.Fatalf("%+v %+v %v native=%d", result, runtime, err, *native)
				}
			}
			if runtime.Paths["ort-library"] != library || m.State().Selection.ORTDirectory != root {
				t.Fatal("установка изменила внешний путь")
			}
		})
	}
}

// TestManagerExplicitFFmpegNeedsOnlyPair сохраняет функциональную проверку внешних программ без notices.
// Даже подходящая пара обязана пройти capabilities, а не проверку состава нашего архива.
func TestManagerExplicitFFmpegNeedsOnlyPair(t *testing.T) {
	m, media, _ := testManager(t)
	pair := externalPair(t)
	if _, err := m.Configure(Selection{FFmpegDirectory: pair}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := m.Check(context.Background(), []string{"audio-pcm"}, false)
	if err != nil || *media != 1 || component(t, snapshot, "ffmpeg").Status != "ready" {
		t.Fatalf("%v %+v", err, snapshot)
	}
	m.options.media = func(context.Context, Manifest, FFmpegPair) (MediaReport, error) {
		return MediaReport{}, errors.New("нет требуемого codec")
	}
	snapshot, err = m.Check(context.Background(), []string{"audio-pcm"}, true)
	if err == nil || component(t, snapshot, "ffmpeg").Status == "ready" || snapshot.Selection.FFmpegDirectory != pair {
		t.Fatalf("capability отказ скрыт: %v %+v", err, snapshot)
	}
}

// TestExternalORTNativeWithoutDistributionFiles запускает настоящий loader в отдельном процессе.
// Источник задаётся разработчиком и только читается, временная копия не содержит docs или aliases.
func TestExternalORTNativeWithoutDistributionFiles(t *testing.T) {
	if os.Getenv("SONGFRAME_TEST_EXTERNAL_ORT_LIBRARY") == "" {
		t.Skip("не задан SONGFRAME_TEST_EXTERNAL_ORT_LIBRARY")
	}
	ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
	defer cancel()
	command := exec.CommandContext(ctx, os.Args[0], "-test.run=^TestExternalORTNativeChild$", "-test.v")
	command.Env = append(os.Environ(), "SONGFRAME_TEST_EXTERNAL_ORT_CHILD=1")
	if output, err := command.CombinedOutput(); err != nil {
		t.Fatalf("native external ORT: %v\n%s", err, output)
	}
}

// TestExternalORTNativeChild проверяет библиотеку в минимальной внешней раскладке через Manager.Check.
// Неполные зависимости производства ожидаемы; результат ORT должен подтвердить loader/API/CPU provider.
func TestExternalORTNativeChild(t *testing.T) {
	if os.Getenv("SONGFRAME_TEST_EXTERNAL_ORT_CHILD") != "1" {
		t.Skip("только дочерний native сценарий")
	}
	source := os.Getenv("SONGFRAME_TEST_EXTERNAL_ORT_LIBRARY")
	m, err := NewManager(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	m.options.lookPath = func(string) (string, error) { return "", os.ErrNotExist }
	a, ok := m.artifact("ort-cpu")
	if !ok {
		t.Fatal("нет runtime для платформы")
	}
	root := filepath.Join(t.TempDir(), "Минимальный внешний runtime")
	target := filepath.Join(root, filepath.FromSlash(a.Entrypoints["ort-library"]))
	if err = os.MkdirAll(filepath.Dir(target), 0700); err != nil {
		t.Fatal(err)
	}
	input, err := os.Open(source)
	if err != nil {
		t.Fatal(err)
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
	if err != nil {
		t.Fatal(err)
	}
	_, copyErr := io.Copy(output, input)
	closeErr := output.Close()
	if copyErr != nil {
		t.Fatal(copyErr)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	if _, err = m.Configure(Selection{ORTDirectory: root}); err != nil {
		t.Fatal(err)
	}
	snapshot, _ := m.Check(context.Background(), []string{"prepare-vocals"}, false)
	runtime := component(t, snapshot, "ort-cpu")
	if runtime.Status != "ready" || runtime.Version == "" || runtime.Paths["ort-library"] != target {
		t.Fatalf("минимальная внешняя ORT не принята: %+v", runtime)
	}
	for _, file := range a.Files {
		if file.Path == a.Entrypoints["ort-library"] {
			continue
		}
		if _, err = os.Lstat(filepath.Join(root, filepath.FromSlash(file.Path))); !os.IsNotExist(err) {
			t.Fatalf("тест случайно сохранил файлы дистрибутива %q: %v", file.Path, err)
		}
	}
}

// TestManagerExplicitModelsKeepPinnedHashes не переносит исключение внешнего runtime на веса и словарь.
// Произвольный открываемый файл модели по-прежнему непригоден без SHA принятого lock.
func TestManagerExplicitModelsKeepPinnedHashes(t *testing.T) {
	m, _, _ := testManager(t)
	installSynthetic(t, m, "ffmpeg")
	installSynthetic(t, m, "ort-cpu")
	file := filepath.Join(t.TempDir(), "Произвольная модель.onnx")
	if err := os.WriteFile(file, []byte("не принятая модель"), 0600); err != nil {
		t.Fatal(err)
	}
	if _, err := m.Configure(Selection{VocalsFile: file}); err != nil {
		t.Fatal(err)
	}
	snapshot, err := m.Check(context.Background(), []string{"prepare-vocals"}, false)
	vocals := component(t, snapshot, "voc-ft")
	if err == nil || vocals.Status != "incompatible" || !strings.Contains(vocals.Reason, "SHA/размером") || vocals.Paths["model"] != file {
		t.Fatalf("SHA внешней модели ослаблен: %v %+v", err, vocals)
	}
}
