package components

import (
	"bytes"
	"context"
	"encoding/binary"
	"fmt"
	"io"
	"math"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"sort"
	"strings"
	"testing"
	"time"
)

// TestMain превращает копию тестового бинарника в управляемую медиапрограмму.
// Так негативные проверки запуска/вывода/отмены не зависят от shell, интерпретаторов или установленного FFmpeg.
func TestMain(m *testing.M) {
	if mode := os.Getenv("SONGFRAME_MEDIA_TEST_HELPER"); mode != "" {
		mediaTestHelper(mode)
		return
	}
	os.Exit(m.Run())
}

// mediaTestHelper имитирует только процессную границу. Настоящие кодеки и рецепты
// проверяются отдельным добровольным TestProbeFFmpegNative на явном каталоге бинарников.
func mediaTestHelper(mode string) {
	role := "ffmpeg"
	if strings.Contains(filepath.Base(os.Args[0]), "ffprobe") {
		role = "ffprobe"
	}
	args := os.Args[1:]
	if mode == "hang" {
		time.Sleep(time.Minute)
		return
	}
	if mode == "noise" {
		for i := 0; i < 20; i++ {
			os.Stdout.Write(bytes.Repeat([]byte("x"), 100000))
		}
		return
	}
	if len(args) > 0 && args[0] == "-version" {
		version := "проверочная-версия"
		if mode == "mismatch" && role == "ffprobe" {
			version = "другая-версия"
		}
		fmt.Printf("%s version %s различающийся-текст-%s\n", role, version, role)
		return
	}
	if mode != "missing-encoder" && mode != "bad-json" {
		fmt.Fprintln(os.Stderr, "Неожиданная команда тестового процесса")
		os.Exit(2)
	}
	if actual := os.Getenv("SONGFRAME_MEDIA_NATIVE_HELPER"); actual != "" {
		suffix := ""
		if runtime.GOOS == "windows" {
			suffix = ".exe"
		}
		command := exec.Command(filepath.Join(actual, role+suffix), args...)
		var stdout bytes.Buffer
		command.Stdout = &stdout
		command.Stderr = os.Stderr
		if err := command.Run(); err != nil {
			os.Exit(3)
		}
		filtering := false
		for _, arg := range args {
			filtering = filtering || arg == "-encoders"
		}
		if !filtering {
			os.Stdout.Write(stdout.Bytes())
			return
		}
		for _, line := range strings.Split(stdout.String(), "\n") {
			if !strings.Contains(line, "libx264") {
				fmt.Fprintln(os.Stdout, line)
			}
		}
		return
	}
	// Контролируемые таблицы и PCM позволяют проверить разделение outcomes даже на машине без FFmpeg.
	option := ""
	for _, arg := range args {
		if arg == "-decoders" || arg == "-encoders" || arg == "-demuxers" || arg == "-filters" || arg == "-protocols" || arg == "-muxers" {
			option = arg
		}
	}
	if option != "" {
		manifest, _ := Load()
		names := map[string]bool{}
		for _, capability := range manifest.Capabilities {
			for category, features := range capability.Features {
				selected := "-" + category
				if category == "decoder_families" {
					selected = "-decoders"
				}
				if selected != option {
					continue
				}
				for _, name := range features {
					if name != "libx264" {
						names[name] = true
					}
				}
			}
		}
		ordered := []string{}
		for name := range names {
			ordered = append(ordered, name)
		}
		sort.Strings(ordered)
		for _, name := range ordered {
			if option == "-protocols" {
				fmt.Println(" " + name)
			} else {
				fmt.Println(" D..... " + name + " описание")
			}
		}
		return
	}
	if role == "ffprobe" && mode == "bad-json" {
		fmt.Print("{повреждённый JSON")
		return
	}
	if role == "ffprobe" {
		fmt.Print(`{"streams":[{"codec_type":"audio","codec_name":"pcm_s16le"}],"format":{"duration":"0.4"}}`)
		return
	}
	format := ""
	for index, arg := range args {
		if arg == "-f" && index+1 < len(args) {
			format = args[index+1]
		}
	}
	if format == "f32le" {
		data := make([]byte, 3200*4)
		for n := 0; n < 3200; n++ {
			binary.LittleEndian.PutUint32(data[n*4:], math.Float32bits(.125))
		}
		os.Stdout.Write(data)
		return
	}
	if format == "s16le" {
		os.Stdout.Write(make([]byte, 17640*4))
		return
	}
	fmt.Fprintln(os.Stderr, "Неподдержанная команда тестового процесса")
	os.Exit(4)
}

// mediaTestPair использует два обычных файла вместо symlink: это не требует привилегий Windows.
func mediaTestPair(t *testing.T, mode string) FFmpegPair {
	t.Helper()
	t.Setenv("SONGFRAME_MEDIA_TEST_HELPER", mode)
	t.Setenv("GORACE", os.Getenv("GORACE")+" atexit_sleep_ms=0")
	root := filepath.Join(t.TempDir(), "Пара с пробелом")
	if err := os.Mkdir(root, 0700); err != nil {
		t.Fatal(err)
	}
	source, err := os.Executable()
	if err != nil {
		t.Fatal(err)
	}
	paths := []string{}
	for _, name := range []string{"ffmpeg", "ffprobe"} {
		if runtime.GOOS == "windows" {
			name += ".exe"
		}
		path := filepath.Join(root, name)
		input, err := os.Open(source)
		if err != nil {
			t.Fatal(err)
		}
		output, err := os.OpenFile(path, os.O_CREATE|os.O_EXCL|os.O_WRONLY, 0700)
		if err != nil {
			input.Close()
			t.Fatal(err)
		}
		_, copyErr := io.Copy(output, input)
		input.Close()
		closeErr := output.Close()
		if copyErr != nil || closeErr != nil {
			t.Fatalf("копия helper: %v, %v", copyErr, closeErr)
		}
		paths = append(paths, path)
	}
	return FFmpegPair{FFmpeg: paths[0], FFprobe: paths[1]}
}

// mediaTestManifest ограничивает test scope медиавозможностями, не меняя встроенный manifest.
func mediaTestManifest(t *testing.T, ids ...string) Manifest {
	t.Helper()
	manifest, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	capabilities := []Capability{}
	for _, capability := range manifest.Capabilities {
		for _, id := range ids {
			if capability.ID == id {
				capabilities = append(capabilities, capability)
			}
		}
	}
	manifest.Capabilities = capabilities
	return manifest
}

// TestProbeFFmpegRejectsPair проверяет явные пути и различающиеся version tokens до recipes.
func TestProbeFFmpegRejectsPair(t *testing.T) {
	manifest := mediaTestManifest(t, "audio-pcm", "montage-export")
	t.Run("относительные пути", func(t *testing.T) {
		report, err := ProbeFFmpeg(context.Background(), manifest, FFmpegPair{"ffmpeg", "ffprobe"})
		if err == nil || report.Operations["audio-pcm"].Status != "error" {
			t.Fatal(report, err)
		}
	})
	t.Run("разные версии", func(t *testing.T) {
		pair := mediaTestPair(t, "mismatch")
		report, err := ProbeFFmpeg(context.Background(), manifest, pair)
		if err == nil || !strings.Contains(err.Error(), "не совпадают") {
			t.Fatal(report, err)
		}
		for _, outcome := range report.Operations {
			if outcome.Status != "incompatible" {
				t.Fatal(outcome)
			}
		}
	})
	t.Run("нет файла", func(t *testing.T) {
		report, err := ProbeFFmpeg(context.Background(), manifest, FFmpegPair{filepath.Join(t.TempDir(), "нет ffmpeg"), filepath.Join(t.TempDir(), "нет ffprobe")})
		if err == nil || report.Operations["audio-pcm"].Status != "error" {
			t.Fatal(report, err)
		}
	})
}

// TestProbeFFmpegMissingEncoderKeepsPCMReady фиксирует главную границу API:
// поломанный libx264 даёт incompatible только монтажу, а аудио действительно проходит свой recipe.
func TestProbeFFmpegMissingEncoderKeepsPCMReady(t *testing.T) {
	pair := mediaTestPair(t, "missing-encoder")
	manifest := mediaTestManifest(t, "audio-pcm", "montage-export")
	// При явном native каталоге тот же тест пропускает настоящие команды, удаляя только запись libx264.
	if native := os.Getenv("SONGFRAME_TEST_MEDIA_BIN"); native != "" {
		absolute, err := filepath.Abs(native)
		if err != nil {
			t.Fatal(err)
		}
		t.Setenv("SONGFRAME_MEDIA_NATIVE_HELPER", absolute)
	}
	report, err := ProbeFFmpeg(context.Background(), manifest, pair)
	if err != nil {
		t.Fatal(err)
	}
	if report.Version != "проверочная-версия" {
		t.Fatal("сравнивался лишний текст версии", report)
	}
	if report.Operations["audio-pcm"].Status != "ready" || report.Operations["montage-export"].Status != "incompatible" || !strings.Contains(report.Operations["montage-export"].Reason, "libx264") {
		t.Fatalf("операции связаны ошибкой: %+v", report)
	}
}

// TestProbeFFmpegCancellation не позволяет зависшему дочернему процессу пережить отмену caller.
func TestProbeFFmpegCancellation(t *testing.T) {
	pair := mediaTestPair(t, "hang")
	manifest := mediaTestManifest(t, "audio-pcm")
	ctx, cancel := context.WithTimeout(context.Background(), 100*time.Millisecond)
	defer cancel()
	started := time.Now()
	report, err := ProbeFFmpeg(ctx, manifest, pair)
	if err == nil || report.Operations["audio-pcm"].Status != "cancelled" || time.Since(started) > 3*time.Second {
		t.Fatal(report, err, time.Since(started))
	}
}

// TestMediaRunnerBounds проверяет лимит памяти и отдельный deadline команды без длинного ожидания.
func TestMediaRunnerBounds(t *testing.T) {
	t.Run("вывод", func(t *testing.T) {
		pair := mediaTestPair(t, "noise")
		runner := mediaRunner{ctx: context.Background(), pair: pair, timeout: time.Second}
		_, err := runner.run(pair.FFmpeg, "-version")
		if err == nil || !strings.Contains(err.Error(), "объём вывода") {
			t.Fatal(err)
		}
	})
	t.Run("время", func(t *testing.T) {
		pair := mediaTestPair(t, "hang")
		runner := mediaRunner{ctx: context.Background(), pair: pair, timeout: 100 * time.Millisecond}
		_, err := runner.run(pair.FFmpeg, "-version")
		if err == nil || mediaOutcome(err).Status != "error" || !strings.Contains(err.Error(), "время ожидания") {
			t.Fatal(err)
		}
	})
}

// TestMediaInputsAreEmbedded проверяет полный состав входов без доступа к checkout во время probe.
func TestMediaInputsAreEmbedded(t *testing.T) {
	for _, name := range []string{"tiny.flac", "vp8-vorbis.webm", "vp9-opus.webm", "tiny.mp3", "tiny.m4a", "tiny.mp4"} {
		data, err := mediaInputs.ReadFile("fixtures/" + name)
		if err != nil || len(data) == 0 {
			t.Fatal(name, err)
		}
	}
}

// TestProbeFFmpegNative выполняет настоящие кодеки и фильтры только на явной паре разработчика.
// Без переменной штатные unit-тесты не требуют FFmpeg, сети или текущего проекта.
func TestProbeFFmpegNative(t *testing.T) {
	directory := os.Getenv("SONGFRAME_TEST_MEDIA_BIN")
	if directory == "" {
		t.Skip("не задан явный каталог SONGFRAME_TEST_MEDIA_BIN")
	}
	directory, err := filepath.Abs(directory)
	if err != nil {
		t.Fatal(err)
	}
	suffix := ""
	if runtime.GOOS == "windows" {
		suffix = ".exe"
	}
	manifest, err := Load()
	if err != nil {
		t.Fatal(err)
	}
	t.Chdir(t.TempDir())
	ctx, cancel := context.WithTimeout(context.Background(), 90*time.Second)
	defer cancel()
	report, err := ProbeFFmpeg(ctx, manifest, FFmpegPair{filepath.Join(directory, "ffmpeg"+suffix), filepath.Join(directory, "ffprobe"+suffix)})
	if err != nil {
		t.Fatal(err)
	}
	for id, outcome := range report.Operations {
		if outcome.Status != "ready" {
			t.Errorf("%s: %+v", id, outcome)
		}
	}
	t.Logf("версия %s, проверено операций: %d", report.Version, len(report.Operations))
}

// TestProbeFFmpegMalformedMetadata отвергает успешный процесс с невалидным JSON,
// чтобы один exit 0 не превращался в готовность работы с пользовательским звуком.
func TestProbeFFmpegMalformedMetadata(t *testing.T) {
	pair := mediaTestPair(t, "bad-json")
	manifest := mediaTestManifest(t, "audio-pcm")
	report, err := ProbeFFmpeg(context.Background(), manifest, pair)
	if err != nil || report.Operations["audio-pcm"].Status != "incompatible" || !strings.Contains(report.Operations["audio-pcm"].Reason, "JSON") {
		t.Fatal(report, err)
	}
}
