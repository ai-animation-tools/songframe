package buildanimatic

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/mediacmd"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
)

// baseProject — копия входного клипа эталона (два плана: принятый монтаж и карточка).
func baseProject(t *testing.T) string {
	t.Helper()
	requireMedia(t, "")
	root, err := golden.Root()
	if err != nil {
		t.Fatal(err)
	}
	return copyTree(t, filepath.Join(root, domain, "base"))
}

// withRun подменяет запуск команд сборки на время теста (patch(build_animatic.run) оригинала).
func withRun(t *testing.T, wrap func(next func(ctx context.Context, program string, args ...string) ([]byte, error)) func(ctx context.Context, program string, args ...string) ([]byte, error)) {
	t.Helper()
	saved := run
	run = wrap(saved)
	t.Cleanup(func() { run = saved })
}

func isNullDecode(args []string) bool {
	return len(args) >= 3 && strings.Join(args[len(args)-3:], " ") == "-f null -"
}

func readFile(t *testing.T, path string) []byte {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

func writeFile(t *testing.T, path, text string) {
	t.Helper()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
		t.Fatal(err)
	}
}

// TestFailedEncodingPreservesLatest — сбой финальной склейки после подготовки фрагментов не
// трогает прежний latest, включая прежнюю HTML-страницу (test_failed_encoding_preserves_…).
func TestFailedEncodingPreservesLatest(t *testing.T) {
	project := baseProject(t)
	latest := filepath.Join(project, "plan/animatic/latest")
	previous := map[string]string{
		"test-output.mp4": "previous video", "manifest.json": `{"video_file": "test-output.mp4"}`,
		"README.md": "Прежнее описание", "index.html": "previous HTML page",
	}
	for name, text := range previous {
		writeFile(t, filepath.Join(latest, name), text)
	}
	withRun(t, func(next func(context.Context, string, ...string) ([]byte, error)) func(context.Context, string, ...string) ([]byte, error) {
		return func(ctx context.Context, program string, args ...string) ([]byte, error) {
			for _, arg := range args {
				if arg == "concat" {
					return nil, pycompat.New(pycompat.ValueError, "Ошибка финального кодирования")
				}
			}
			return next(ctx, program, args...)
		}
	})
	output := Run(context.Background(), project, nil)
	if output.Code != 1 || output.Stderr != "Ошибка финального кодирования\n" || output.Stdout != "M01 подготовлена\nM02 подготовлена\n" {
		t.Fatalf("исход %+v", output)
	}
	entries, _ := os.ReadDir(latest)
	if len(entries) != len(previous) {
		t.Fatalf("latest %v", entries)
	}
	for name, text := range previous {
		if string(readFile(t, filepath.Join(latest, name))) != text {
			t.Fatalf("%s изменён", name)
		}
	}
}

// TestChangesDuringBuild — входы, изменённые между кодированием и публикацией, останавливают
// сборку без замены latest; изменение только настроек генерации — нет.
func TestChangesDuringBuild(t *testing.T) {
	cases := []struct {
		name, file, text, message string
	}{
		{"generation", "plan/project.json", `{"schema_version": 1, "name": "Тестовый клип", "animatic_video": "test-output.mp4", "generation": {"video": {"provider": "test", "model": "новая"}}}`, ""},
		{"project", "plan/project.json", `{"schema_version": 1, "name": "Изменилось во время сборки", "animatic_video": "test-output.mp4"}`, textProjectChanged},
		{"registry", "plan/scenes.json", "", textRegistryChanged},
		{"track", "source/track.mp3", "", textTrackChanged},
		{"input", "plan/animatic/cards/M02.png", "", textInputChanged},
		{"card-source", "source/pier.png", "", textCardSourceChanged},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			project := baseProject(t)
			first := Run(context.Background(), project, nil)
			if first.Code != 0 {
				t.Fatalf("первая сборка %+v", first)
			}
			manifest := filepath.Join(project, "plan/animatic/latest/manifest.json")
			before := readFile(t, manifest)
			withRun(t, func(next func(context.Context, string, ...string) ([]byte, error)) func(context.Context, string, ...string) ([]byte, error) {
				return func(ctx context.Context, program string, args ...string) ([]byte, error) {
					result, err := next(ctx, program, args...)
					if isNullDecode(args) {
						path := filepath.Join(project, filepath.FromSlash(c.file))
						text := c.text
						if text == "" {
							text = string(readFile(t, path)) + " "
						}
						writeFile(t, path, text)
					}
					return result, err
				}
			})
			output := Run(context.Background(), project, nil)
			if c.message == "" {
				if output.Code != 0 {
					t.Fatalf("исход %+v", output)
				}
				return
			}
			if output.Code != 1 || output.Stderr != c.message+"\n" {
				t.Fatalf("исход %+v", output)
			}
			if string(readFile(t, manifest)) != string(before) {
				t.Fatal("latest изменён")
			}
		})
	}
}

// TestInvalidMediaChecks — проверки ffprobe фрагмента и готового MP4: число кадров фрагмента,
// формат результата и длина звука (подмена ответа ffprobe).
func TestInvalidMediaChecks(t *testing.T) {
	stream := func(info map[string]any, kind string) map[string]any {
		for _, item := range info["streams"].([]any) {
			if value := item.(map[string]any); value["codec_type"] == kind {
				return value
			}
		}
		t.Fatalf("нет потока %s", kind)
		return nil
	}
	cases := []struct {
		name, match string
		change      func(info map[string]any)
		message     string
	}{
		{"segment", string(filepath.Separator) + ".pending-", func(info map[string]any) { stream(info, "video")["nb_frames"] = "11" }, textSegmentInvalid},
		{"result-frames", "test-output.mp4", func(info map[string]any) { stream(info, "video")["nb_frames"] = "23" }, textResultInvalid},
		{"result-chapters", "test-output.mp4", func(info map[string]any) { info["chapters"] = []any{} }, textResultInvalid},
		{"result-channels", "test-output.mp4", func(info map[string]any) { stream(info, "audio")["channels"] = 1 }, textResultInvalid},
		{"result-rate", "test-output.mp4", func(info map[string]any) { stream(info, "audio")["sample_rate"] = "48000" }, textResultInvalid},
		{"result-audio", "test-output.mp4", func(info map[string]any) { stream(info, "audio")["duration"] = "0.804" }, textAudioChanged},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			project := baseProject(t)
			withRun(t, func(next func(context.Context, string, ...string) ([]byte, error)) func(context.Context, string, ...string) ([]byte, error) {
				return func(ctx context.Context, program string, args ...string) ([]byte, error) {
					result, err := next(ctx, program, args...)
					if err == nil && program == mediacmd.FFprobe() && strings.Contains(args[len(args)-1], c.match) {
						var info map[string]any
						if err := json.Unmarshal(result, &info); err != nil {
							t.Fatal(err)
						}
						c.change(info)
						if result, err = json.Marshal(info); err != nil {
							t.Fatal(err)
						}
					}
					return result, err
				}
			})
			output := Run(context.Background(), project, nil)
			if output.Code != 1 || output.Stderr != c.message+"\n" {
				t.Fatalf("исход %+v", output)
			}
			if _, err := os.Stat(filepath.Join(project, "plan/animatic/latest")); !errors.Is(err, os.ErrNotExist) {
				t.Fatal("latest создан")
			}
		})
	}
}

// TestCachePartialAndCorrupted — test_partial_and_corrupted_entries_are_rebuilt оригинала:
// повреждённая производная и потерянная квитанция пересоздаются, прерванная запись не готова.
func TestCachePartialAndCorrupted(t *testing.T) {
	cache := &artifactCache{directory: t.TempDir()}
	calls := 0
	producer := func(path string) (any, error) {
		calls++
		if err := os.WriteFile(path, []byte("готовая производная"), 0o644); err != nil {
			return nil, err
		}
		return pytool.Record("valid", true), nil
	}
	recipe := pytool.Record("input", "one")
	first, err := cache.obtain("sample", recipe, ".bin", producer)
	if err != nil {
		t.Fatal(err)
	}
	if _, err := cache.obtain("sample", recipe, ".bin", producer); err != nil || calls != 1 {
		t.Fatalf("тёплое обращение: %v, вызовов %d", err, calls)
	}
	writeFile(t, first, "broken")
	if _, err := cache.obtain("sample", recipe, ".bin", producer); err != nil || calls != 2 {
		t.Fatalf("повреждённая производная: %v, вызовов %d", err, calls)
	}
	key, artifact, receipt, err := cache.paths("sample", recipe, ".bin")
	if err != nil {
		t.Fatal(err)
	}
	if err := os.Remove(receipt); err != nil {
		t.Fatal(err)
	}
	if _, err := cache.obtain("sample", recipe, ".bin", producer); err != nil || calls != 3 {
		t.Fatalf("без квитанции: %v, вызовов %d", err, calls)
	}
	if _, hit := cache.lookup(key, artifact, receipt); !hit {
		t.Fatal("готовая запись не найдена")
	}
	interrupted := pytool.Record("input", "two")
	_, err = cache.obtain("sample", interrupted, ".bin", func(path string) (any, error) {
		_ = os.WriteFile(path, []byte("partial"), 0o644)
		return nil, errors.New("Прервано")
	})
	if err == nil || err.Error() != "Прервано" {
		t.Fatalf("ошибка %v", err)
	}
	key, artifact, receipt, _ = cache.paths("sample", interrupted, ".bin")
	if _, hit := cache.lookup(key, artifact, receipt); hit {
		t.Fatal("прерванная запись считается готовой")
	}
	if leftovers, _ := filepath.Glob(filepath.Join(cache.directory, "sample", ".pending-*")); len(leftovers) > 0 {
		t.Fatalf("остались %v", leftovers)
	}
}

// TestFrameRounding — frame(): половина кадра округляется вверх, как ROUND_HALF_UP.
func TestFrameRounding(t *testing.T) {
	for text, want := range map[string]string{"0": "0", "0.4": "12", "0.0166666": "0", "0.0166667": "1", "1.05": "32", "-0.05": "-2"} {
		got, err := frame(text)
		if err != nil || got.String() != want {
			t.Fatalf("frame(%s) = %v %v, ждали %s", text, got, err, want)
		}
	}
}
