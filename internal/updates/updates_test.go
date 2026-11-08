package updates

import (
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"go/ast"
	"go/parser"
	"go/token"
	"net/http"
	"net/http/httptest"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"slices"
	"strconv"
	"strings"
	"testing"
	"time"
)

// Обновления проверяются на подставном GitHub: без сети, с настоящими файлами во временной
// папке.

var packageBytes = []byte("новая версия приложения")

func downloadURL(version, name string) string {
	return "https://github.com/" + Repository + "/releases/download/v" + version + "/" + name
}

// releaseJSON — описание выпуска GitHub с пакетом поставки и соседней контрольной суммой.
func releaseJSON(version string, kind Kind, data []byte) map[string]any {
	name := PackageName(version, kind)
	sum := sha256.Sum256(data)
	return map[string]any{
		"tag_name": "v" + version, "draft": false, "prerelease": false,
		"assets": []map[string]any{
			{"name": name + ".sha256", "size": 10, "digest": "sha256:" + strings.Repeat("0", 64), "browser_download_url": downloadURL(version, name+".sha256")},
			{"name": name, "size": len(data), "digest": "sha256:" + hex.EncodeToString(sum[:]), "browser_download_url": downloadURL(version, name)},
		},
	}
}

func encode(t *testing.T, value any) []byte {
	t.Helper()
	data, err := json.Marshal(value)
	if err != nil {
		t.Fatal(err)
	}
	return data
}

// github отвечает на запросы клиента без сети: latest — описание или код ошибки, пакет — served.
type github struct {
	latest any
	served []byte
}

func (g github) RoundTrip(request *http.Request) (*http.Response, error) {
	recorder := httptest.NewRecorder()
	url := request.URL.String()
	switch {
	case strings.HasSuffix(url, "/releases/latest"):
		if code, ok := g.latest.(int); ok {
			recorder.WriteHeader(code)
		} else {
			data, _ := json.Marshal(g.latest)
			recorder.Write(data)
		}
	case strings.HasPrefix(url, "https://github.com/"+Repository+"/releases/download/"):
		recorder.Write(g.served)
	default:
		recorder.WriteHeader(http.StatusNotFound)
	}
	return recorder.Result(), nil
}

// calls — вызовы платформенных действий менеджера.
type calls struct {
	launch, relaunch, reveal []string
	quit                     int
}

func manager(t *testing.T, server github, options Options) (*Manager, *calls) {
	t.Helper()
	if options.CurrentVersion == "" {
		options.CurrentVersion = "0.2.0"
	}
	if options.Kind == "" {
		options.Kind = KindManual
	}
	if options.Directory == "" {
		options.Directory = filepath.Join(t.TempDir(), "state", "updates")
	}
	if server.served == nil {
		server.served = packageBytes
	}
	record := &calls{}
	options.Client = &http.Client{Transport: server}
	options.Launch = func(file string) error { record.launch = append(record.launch, file); return nil }
	options.Relaunch = func(file string) error { record.relaunch = append(record.relaunch, file); return nil }
	options.Reveal = func(file string) error { record.reveal = append(record.reveal, file); return nil }
	options.Quit = func() { record.quit++ }
	return New(options), record
}

func TestNewer(t *testing.T) {
	for _, item := range []struct {
		candidate, current string
		want               bool
	}{
		{"0.10.0", "0.9.9", true}, {"1.0.0", "0.99.99", true}, {"0.2.0", "0.2.0", false}, {"0.1.9", "0.2.0", false},
		// Сборка разработки младше своего выпуска и старше предыдущего.
		{"1.0.0", "1.0.0-dev.47", true}, {"0.9.0", "1.0.0-dev.47", false}, {"1.0.0", "0.0.0-dev", true},
		{"1.0.0-beta", "0.1.0", false}, {"1.0.0", "сборка", false},
	} {
		if got := Newer(item.candidate, item.current); got != item.want {
			t.Errorf("Newer(%q, %q) = %v", item.candidate, item.current, got)
		}
	}
}

func TestReleasePackage(t *testing.T) {
	found, err := ReleasePackage(encode(t, releaseJSON("0.3.0", KindWindows, packageBytes)), KindWindows, "0.2.0")
	if err != nil || found.Version != "0.3.0" || found.Name != "songframe-0.3.0-win-x64-setup.exe" ||
		found.Page != "https://github.com/"+Repository+"/releases/tag/v0.3.0" || found.Size != int64(len(packageBytes)) {
		t.Fatalf("пакет Windows: %+v, %v", found, err)
	}
	if found, err := ReleasePackage(encode(t, releaseJSON("1.2.3", KindDeb, packageBytes)), KindDeb, "0.2.0"); err != nil || found.Name != "songframe-1.2.3-linux-amd64.deb" {
		t.Fatalf("пакет deb: %+v, %v", found, err)
	}
	broken := func(change func(map[string]any)) []byte {
		value := releaseJSON("0.3.0", KindAppImage, packageBytes)
		change(value)
		return encode(t, value)
	}
	assetOf := func(value map[string]any) map[string]any { return value["assets"].([]map[string]any)[1] }
	for name, data := range map[string][]byte{
		"черновик":    broken(func(v map[string]any) { v["draft"] = true }),
		"prerelease":  broken(func(v map[string]any) { v["tag_name"] = "v0.3.0-beta" }),
		"чужой адрес": broken(func(v map[string]any) { assetOf(v)["browser_download_url"] = "https://example.com/songframe.AppImage" }),
		"без digest":  broken(func(v map[string]any) { assetOf(v)["digest"] = nil }),
		"без размера": broken(func(v map[string]any) { assetOf(v)["size"] = 0 }),
		"не JSON":     []byte("<html>"),
	} {
		if _, err := ReleasePackage(data, KindAppImage, "0.2.0"); err == nil || err.Error() != textInvalidRelease {
			t.Errorf("%s: %v", name, err)
		}
	}
	linux := encode(t, releaseJSON("0.3.0", KindAppImage, packageBytes))
	for _, kind := range []Kind{KindWindows, KindDeb} {
		if _, err := ReleasePackage(linux, kind, "0.2.0"); err == nil || err.Error() != textPackageMissing {
			t.Errorf("%s: %v", kind, err)
		}
		// Выпуск не новее установленного не обязан содержать пакет этой поставки.
		if found, err := ReleasePackage(linux, kind, "1.0.0-dev.47"); found != nil || err != nil {
			t.Errorf("%s, прежний выпуск: %+v, %v", kind, found, err)
		}
	}
}

func TestCheckCurrentAndErrors(t *testing.T) {
	ctx := context.Background()
	service, _ := manager(t, github{latest: releaseJSON("0.2.0", KindManual, packageBytes)}, Options{})
	if view := service.Check(ctx); view != (View{Status: StatusCurrent, CurrentVersion: "0.2.0", Message: textCurrent}) {
		t.Fatalf("актуальная версия: %+v", view)
	}
	// deb-версия 1.0 против прежнего выпуска только с AppImage: актуальная версия, а не
	// «нет пакета».
	older, _ := manager(t, github{latest: releaseJSON("0.5.0", KindAppImage, packageBytes)}, Options{Kind: KindDeb, CurrentVersion: "1.0.0-dev.47"})
	if view := older.Check(ctx); view.Status != StatusCurrent || view.Message != textCurrent {
		t.Fatalf("прежний выпуск без deb: %+v", view)
	}
	failing, _ := manager(t, github{latest: http.StatusForbidden}, Options{})
	if view := failing.Check(ctx); view.Status != StatusError || view.Message != textCheckFailed {
		t.Fatalf("ошибка GitHub: %+v", view)
	}
	if view := failing.Download(ctx); view.Status != StatusError || view.Message != textCheckFirst {
		t.Fatalf("скачивание без проверки: %+v", view)
	}
}

func TestDownloadKeepsOnlyNewPackage(t *testing.T) {
	ctx := context.Background()
	state := filepath.Join(t.TempDir(), "state")
	directory := filepath.Join(state, "updates")
	service, _ := manager(t, github{latest: releaseJSON("0.3.0", KindManual, packageBytes)}, Options{Directory: directory})
	if view := service.Check(ctx); view.Status != StatusAvailable || view.Version != "0.3.0" || view.Installable || view.Message != fmt.Sprintf(textAvailable, "0.3.0") {
		t.Fatalf("найдена версия: %+v", view)
	}
	// Прежний пакет удаляется, соседние данные каталога состояния остаются.
	if err := os.MkdirAll(directory, 0o755); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(directory, "songframe-0.2.1-linux-x86_64.AppImage"), []byte("прежний пакет"), 0o644)
	os.WriteFile(filepath.Join(state, "settings.json"), []byte("{}"), 0o644)
	view := service.Download(ctx)
	if view.Status != StatusReady || view.Version != "0.3.0" || view.Message != fmt.Sprintf(textReady, "0.3.0")+" "+textReadyManual {
		t.Fatalf("готово: %+v", view)
	}
	if names := list(t, directory); !slices.Equal(names, []string{"songframe-0.3.0-linux-x86_64.AppImage"}) {
		t.Fatalf("папка обновлений: %v", names)
	}
	if data, _ := os.ReadFile(filepath.Join(directory, "songframe-0.3.0-linux-x86_64.AppImage")); string(data) != string(packageBytes) {
		t.Fatal("содержимое пакета")
	}
	if _, err := os.Stat(filepath.Join(state, "settings.json")); err != nil {
		t.Fatal(err)
	}
}

func TestDownloadRejectsWrongPackage(t *testing.T) {
	ctx := context.Background()
	directory := filepath.Join(t.TempDir(), "updates")
	for name, served := range map[string][]byte{
		"подмена": []byte("подменённый пакет прил"),
		"длиннее": append(append([]byte{}, packageBytes...), 'x'),
		"короче":  packageBytes[:5],
	} {
		service, _ := manager(t, github{latest: releaseJSON("0.3.0", KindManual, packageBytes), served: served}, Options{Directory: directory})
		service.Check(ctx)
		if view := service.Download(ctx); view.Status != StatusError || view.Version != "0.3.0" || view.Message != textHashMismatch {
			t.Fatalf("%s: %+v", name, view)
		}
		if names := list(t, directory); len(names) != 0 {
			t.Fatalf("%s: остались %v", name, names)
		}
		if view := service.Install(); view.Message != textCheckFirst {
			t.Fatalf("%s: установка %+v", name, view)
		}
	}
}

func TestDebShowsPackage(t *testing.T) {
	ctx := context.Background()
	service, record := manager(t, github{latest: releaseJSON("0.3.0", KindDeb, packageBytes)}, Options{Kind: KindDeb})
	service.Check(ctx)
	if view := service.Download(ctx); view.Installable || view.Message != fmt.Sprintf(textReady, "0.3.0")+" "+textReadyPackage {
		t.Fatalf("deb: %+v", view)
	}
	service.Install()
	if len(record.reveal) != 1 || filepath.Base(record.reveal[0]) != "songframe-0.3.0-linux-amd64.deb" || record.quit != 0 {
		t.Fatalf("deb: %+v", record)
	}
}

func TestInstallAppImage(t *testing.T) {
	ctx := context.Background()
	folder := filepath.Join(t.TempDir(), "Приложения")
	os.Mkdir(folder, 0o755)
	appImage := filepath.Join(folder, "SongFrame.AppImage")
	os.WriteFile(appImage, []byte("старая версия"), 0o755)
	service, record := manager(t, github{latest: releaseJSON("0.3.0", KindAppImage, packageBytes)}, Options{Kind: KindAppImage, AppImage: appImage})
	if view := service.Check(ctx); !view.Installable {
		t.Fatalf("installable: %+v", view)
	}
	if view := service.Download(ctx); view.Status != StatusReady || view.Message != fmt.Sprintf(textReady, "0.3.0") {
		t.Fatalf("готово: %+v", view)
	}
	service.Install()
	if data, _ := os.ReadFile(appImage); string(data) != string(packageBytes) {
		t.Fatal("AppImage не заменён")
	}
	if info, _ := os.Stat(appImage); runtime.GOOS != "windows" && info.Mode().Perm() != 0o755 {
		t.Fatalf("права %v", info.Mode())
	}
	if names := list(t, folder); !slices.Equal(names, []string{"SongFrame.AppImage"}) {
		t.Fatalf("папка: %v", names)
	}
	if !slices.Equal(record.relaunch, []string{appImage}) || record.quit != 1 || len(record.launch) != 0 || len(record.reveal) != 0 {
		t.Fatalf("вызовы: %+v", record)
	}
}

func TestInstallWindowsAndManual(t *testing.T) {
	ctx := context.Background()
	directory := filepath.Join(t.TempDir(), "updates")
	windows, record := manager(t, github{latest: releaseJSON("0.3.0", KindWindows, packageBytes)}, Options{Kind: KindWindows, Directory: directory})
	windows.Check(ctx)
	windows.Download(ctx)
	windows.Install()
	if !slices.Equal(record.launch, []string{filepath.Join(directory, "songframe-0.3.0-win-x64-setup.exe")}) || record.quit != 1 {
		t.Fatalf("Windows: %+v", record)
	}
	manual, record := manager(t, github{latest: releaseJSON("0.3.0", KindManual, packageBytes)}, Options{Directory: directory})
	manual.Check(ctx)
	manual.Download(ctx)
	manual.Install()
	if !slices.Equal(record.reveal, []string{filepath.Join(directory, "songframe-0.3.0-linux-x86_64.AppImage")}) || record.quit != 0 || len(record.relaunch) != 0 {
		t.Fatalf("вручную: %+v", record)
	}
}

func TestRelaunchEnvironment(t *testing.T) {
	mount := "/tmp/.mount_SongFrAbc123"
	got := RelaunchEnvironment([]string{
		"APPDIR=" + mount, "APPIMAGE=/home/u/SongFrame.AppImage", "ARGV0=./SongFrame.AppImage", "OWD=/home/u",
		"PATH=" + mount + ":" + mount + "/usr/sbin:/usr/bin:/bin", "LD_LIBRARY_PATH=" + mount + "/usr/lib", "HOME=/home/u",
	})
	if !slices.Equal(got, []string{"PATH=/usr/bin:/bin", "HOME=/home/u"}) {
		t.Fatalf("%v", got)
	}
}

// TestRelaunchArgs: помощник ждёт выхода процесса, закрывает унаследованные дескрипторы и
// запускает новый файл.
func TestRelaunchArgs(t *testing.T) {
	if runtime.GOOS != "linux" {
		t.Skip("перезапуск AppImage — только Linux")
	}
	work := t.TempDir()
	report := filepath.Join(work, "report")
	appImage := filepath.Join(work, "Новый SongFrame.AppImage")
	os.WriteFile(appImage, []byte("#!/bin/sh\n[ -e /proc/$$/fd/3 ] && echo open \"$1\" > \"$REPORT\" || echo closed \"$1\" > \"$REPORT\"\n"), 0o755)
	running := exec.Command("sleep", "0.5")
	if err := running.Start(); err != nil {
		t.Fatal(err)
	}
	inherited, err := os.Create(filepath.Join(work, "файл старого монтирования"))
	if err != nil {
		t.Fatal(err)
	}
	relaunch := exec.Command("/bin/bash", RelaunchArgs(running.Process.Pid, appImage, "--smoke")...)
	relaunch.ExtraFiles = []*os.File{inherited}
	relaunch.Env = append(os.Environ(), "REPORT="+report)
	if err := relaunch.Start(); err != nil {
		t.Fatal(err)
	}
	inherited.Close()
	time.Sleep(200 * time.Millisecond)
	if _, err := os.Stat(report); err == nil {
		t.Fatal("новый файл запущен до выхода процесса")
	}
	running.Wait()
	relaunch.Wait()
	if data, _ := os.ReadFile(report); string(data) != "closed --smoke\n" {
		t.Fatalf("отчёт %q", data)
	}
}

// TestTextsMatchFrontend: каждое сообщение texts.go дословно есть в updatesTexts renderer;
// %s соответствует подстановке ${version}.
func TestTextsMatchFrontend(t *testing.T) {
	data, err := os.ReadFile(filepath.Join("..", "..", "frontend", "src", "shared", "texts", "updates.ts"))
	if err != nil {
		t.Fatal(err)
	}
	source := string(data)
	file, err := parser.ParseFile(token.NewFileSet(), "texts.go", nil, 0)
	if err != nil {
		t.Fatal(err)
	}
	checked := 0
	ast.Inspect(file, func(node ast.Node) bool {
		literal, ok := node.(*ast.BasicLit)
		if !ok || literal.Kind != token.STRING {
			return true
		}
		value, _ := strconv.Unquote(literal.Value)
		quoted := "'" + value + "'"
		if strings.Contains(value, "%s") {
			quoted = "`" + strings.ReplaceAll(value, "%s", "${version}") + "`"
		}
		if !strings.Contains(source, quoted) {
			t.Errorf("%q нет в updatesTexts", value)
		}
		checked++
		return true
	})
	if checked != 12 {
		t.Fatalf("проверено %d текстов", checked)
	}
}

func list(t *testing.T, directory string) []string {
	t.Helper()
	entries, err := os.ReadDir(directory)
	if err != nil {
		t.Fatal(err)
	}
	names := []string{}
	for _, entry := range entries {
		names = append(names, entry.Name())
	}
	return names
}

func TestDetectKind(t *testing.T) {
	for _, item := range []struct {
		goos, appImage, executable string
		want                       Kind
	}{
		{"windows", "", `C:\Users\u\AppData\Local\Programs\SongFrame Desktop\songframe.exe`, KindWindows},
		{"linux", "/home/u/SongFrame.AppImage", "/tmp/.mount_x/usr/bin/songframe", KindAppImage},
		{"linux", "", "/usr/bin/songframe", KindDeb},
		{"linux", "", "/home/u/songframe/build/bin/songframe", KindManual},
	} {
		if got := DetectKind(item.goos, item.appImage, item.executable); got != item.want {
			t.Errorf("%+v: %s", item, got)
		}
	}
}
