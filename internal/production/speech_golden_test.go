package production_test

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"sort"
	"strings"
	"testing"

	"songframe-go/internal/golden"
	"songframe-go/internal/production"
)

// speechStep — шаг сценария prepareSpeech домена cut-speech (service.json): вызов на пакете с
// границами или без, правка файлов до вызова, исход оригинала и содержимое audio/ пакета после.
type speechStep struct {
	Label      string             `json:"label"`
	PackageDir string             `json:"packageDir"`
	Bounds     *production.Bounds `json:"bounds"`
	Write      map[string]string  `json:"write"`
	Result     json.RawMessage    `json:"result"`
	Error      *string            `json:"error"`
	Audio      map[string]struct {
		Text   *string `json:"text"`
		SHA256 string  `json:"sha256"`
		Bytes  int     `json:"bytes"`
	} `json:"audio"`
}

// TestPrepareSpeechGolden — Production.prepareSpeech оригинала на образце checks-base с
// настоящим cut_speech (FFmpeg, песня MP3): предложенный и явный срез, замена прежнего среза,
// отказы проверок и инструмента (с удалением прежнего WAV), отправленная попытка, пакет без shot и
// папка не пакета. SHA-256 WAV (декодирование MP3) сверяется только при той же версии FFmpeg.
func TestPrepareSpeechGolden(t *testing.T) {
	if _, err := exec.LookPath("ffmpeg"); err != nil {
		t.Skip("нет ffmpeg в PATH")
	}
	var document struct {
		FFmpegVersion string            `json:"ffmpegVersion"`
		Inputs        map[string]string `json:"inputs"`
		Steps         []speechStep      `json:"steps"`
	}
	if err := json.Unmarshal(golden.ReadFile(t, "cut-speech", "service.json"), &document); err != nil {
		t.Fatal(err)
	}
	version, _ := exec.Command("ffmpeg", "-version").Output()
	sameFFmpeg := strings.SplitN(string(version), "\n", 2)[0] == document.FFmpegVersion

	project, err := filepath.EvalSymlinks(t.TempDir())
	if err != nil {
		t.Fatal(err)
	}
	project = filepath.Join(project, "project")
	copyTree(t, filepath.Join("..", "..", "testdata", "golden", "checks-base", "project"), project)
	// Пакет отправленной попытки — копия M03-attempt-01 с запросом (как в скрипте съёмки).
	copyTree(t, filepath.Join(project, "plan", "batches", "M03-attempt-01"), filepath.Join(project, "plan", "batches", "M03-attempt-02"))
	write := func(rel, text string) {
		path := filepath.Join(project, filepath.FromSlash(rel))
		if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(path, []byte(text), 0o644); err != nil {
			t.Fatal(err)
		}
	}
	for rel, text := range document.Inputs {
		write(rel, text)
	}
	service := production.New(production.Options{})
	audio := filepath.Join(project, "plan", "batches", "M03-attempt-01", "audio")
	for _, step := range document.Steps {
		for rel, text := range step.Write {
			write(rel, text)
		}
		dir := strings.ReplaceAll(step.PackageDir, "<project>", project)
		view, err := service.PrepareSpeech(project, dir, step.Bounds)
		switch {
		case step.Error != nil:
			if err == nil {
				t.Fatalf("%s: ожидалась ошибка %q", step.Label, *step.Error)
			}
			if got := strings.ReplaceAll(err.Error(), project, "<project>"); got != *step.Error {
				t.Fatalf("%s: ошибка\n%q\nожидалась\n%q", step.Label, got, *step.Error)
			}
		case err != nil:
			t.Fatalf("%s: %v", step.Label, err)
		default:
			golden.AssertValue(t, step.Result, view, project)
		}
		entries, _ := os.ReadDir(audio)
		names := []string{}
		for _, entry := range entries {
			names = append(names, entry.Name())
		}
		want := []string{}
		for name := range step.Audio {
			want = append(want, name)
		}
		sort.Strings(want)
		if strings.Join(names, ",") != strings.Join(want, ",") {
			t.Fatalf("%s: audio/ %v, ожидалось %v", step.Label, names, want)
		}
		for name, expected := range step.Audio {
			data, err := os.ReadFile(filepath.Join(audio, name))
			if err != nil {
				t.Fatal(err)
			}
			switch {
			case expected.Text != nil && sameFFmpeg:
				if string(data) != *expected.Text {
					t.Fatalf("%s: %s\n%s\nожидалось\n%s", step.Label, name, data, *expected.Text)
				}
			case expected.Text != nil:
				// Другая версия FFmpeg: SHA-256 WAV из MP3 может отличаться, остальное — нет.
				golden.AssertJSON(t, withoutOutputSHA(t, []byte(*expected.Text)), withoutOutputSHA(t, data))
			default:
				sum := sha256.Sum256(data)
				if len(data) != expected.Bytes || (sameFFmpeg && hex.EncodeToString(sum[:]) != expected.SHA256) {
					t.Fatalf("%s: %s %x (%d байт), ожидалось %s (%d)", step.Label, name, sum, len(data), expected.SHA256, expected.Bytes)
				}
			}
		}
	}
}

// withoutOutputSHA — рецепт без output.sha256 для сверки при другой версии FFmpeg.
func withoutOutputSHA(t *testing.T, data []byte) []byte {
	t.Helper()
	var recipe map[string]any
	if err := json.Unmarshal(data, &recipe); err != nil {
		t.Fatal(err)
	}
	if output, ok := recipe["output"].(map[string]any); ok {
		delete(output, "sha256")
	}
	result, _ := json.Marshal(recipe)
	return result
}
