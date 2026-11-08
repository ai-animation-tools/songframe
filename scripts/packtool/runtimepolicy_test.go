package main

// Регрессии политики runtime на маленьких синтетических ELF, без настоящего AppDir.
// Каждый сценарий владеет только своим t.TempDir(); скомпилированные ELF никогда не
// запускаются и служат лишь входом анализа readelf.

import (
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"reflect"
	"slices"
	"strings"
	"testing"
)

// policyFixture — независимый валидный набор GTK4/WebKit6 в каталоге с пробелом и кириллицей.
type policyFixture struct {
	t      *testing.T
	base   string
	root   string
	source string
}

// newPolicyFixture создаёт текущий стек; без gcc и readelf тест пропускается.
func newPolicyFixture(t *testing.T) *policyFixture {
	t.Helper()
	for _, tool := range []string{"gcc", "readelf"} {
		if _, err := exec.LookPath(tool); err != nil {
			t.Skip("Нужны gcc и readelf для синтетических ELF")
		}
	}
	base := t.TempDir()
	f := &policyFixture{t: t, base: base, root: filepath.Join(base, "Проверочный AppDir"), source: filepath.Join(base, "fixture.c")}
	if err := os.Mkdir(f.root, 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.source, []byte("int fixture(void) { return 0; }\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	for _, soname := range requiredLibraries {
		f.compile("usr/lib/"+soname, soname)
	}
	for _, name := range requiredHelpers {
		f.compile("usr/lib/webkitgtk-6.0/"+name, "")
	}
	return f
}

// compile закрепляет SONAME и принудительные DT_NEEDED без libc.
func (f *policyFixture) compile(relative, soname string, needed ...string) string {
	f.t.Helper()
	output := filepath.Join(f.root, relative)
	if err := os.MkdirAll(filepath.Dir(output), 0o755); err != nil {
		f.t.Fatal(err)
	}
	arguments := []string{"-shared", "-fPIC", "-nostdlib", f.source, "-o", output}
	if soname != "" {
		arguments = append(arguments, "-Wl,-soname,"+soname)
	}
	if len(needed) > 0 {
		arguments = append(append(arguments, "-Wl,--no-as-needed"), needed...)
	}
	if out, err := exec.Command("gcc", arguments...).CombinedOutput(); err != nil {
		f.t.Fatalf("gcc: %v\n%s", err, out)
	}
	return output
}

// path — абсолютный путь внутри AppDir.
func (f *policyFixture) path(relative string) string { return filepath.Join(f.root, relative) }

// snapshot снимает имена и hash собственного дерева, чтобы отказ prune доказуемо ничего не менял.
func (f *policyFixture) snapshot() map[string]string {
	f.t.Helper()
	snapshot, err := inventory(f.root)
	if err != nil {
		f.t.Fatal(err)
	}
	result := map[string]string{}
	for relative, item := range snapshot.entries {
		if item.kind == "file" {
			data, err := os.ReadFile(f.path(relative))
			if err != nil {
				f.t.Fatal(err)
			}
			sum := sha256.Sum256(data)
			result[relative] = hex.EncodeToString(sum[:])
		} else {
			result[relative] = item.kind + ":" + item.target
		}
	}
	return result
}

// addLegacy воспроизводит второй backend, который Wails копировал вместе с GTK4 helpers.
func (f *policyFixture) addLegacy() {
	for _, name := range []string{"libgtk-3.so.0", "libgdk-3.so.0", "libwebkit2gtk-4.1.so.0", "libjavascriptcoregtk-4.1.so.0"} {
		f.compile("usr/lib/"+name, name)
	}
	for _, name := range append(slices.Clone(requiredHelpers), "WebKitGPUProcess") {
		f.compile("usr/lib/webkit2gtk-4.1/"+name, "")
	}
	typelibs := f.path("usr/lib/girepository-1.0")
	if err := os.MkdirAll(typelibs, 0o755); err != nil {
		f.t.Fatal(err)
	}
	for _, name := range []string{"Gtk-3.0.typelib", "Gdk-3.0.typelib", "WebKit2-4.1.typelib", "WebKit2WebExtension-4.1.typelib", "JavaScriptCore-4.1.typelib"} {
		if err := os.WriteFile(filepath.Join(typelibs, name), []byte("synthetic typelib"), 0o644); err != nil {
			f.t.Fatal(err)
		}
	}
}

// run выполняет политику над AppDir фикстуры.
func (f *policyFixture) run(action string) policyReport { return executePolicy(action, f.root) }

// symlink создаёт ссылку внутри или вне AppDir.
func (f *policyFixture) symlink(target, link string) {
	f.t.Helper()
	if err := os.Symlink(target, link); err != nil {
		f.t.Fatal(err)
	}
}

// expectStatus проверяет итог и печатает отчёт при расхождении.
func expectStatus(t *testing.T, report policyReport, status string) {
	t.Helper()
	if report.status() != status {
		t.Fatalf("ожидался status %s: %s", status, policyJSON(report))
	}
}

// isSymlink — путь является ссылкой.
func isSymlink(path string) bool {
	info, err := os.Lstat(path)
	return err == nil && info.Mode()&os.ModeSymlink != 0
}

// Чистая политика пропускает общие библиотеки GTK4 и не меняет ни одного байта.
func TestPolicyCurrentStackIsReadyAndCheckIsReadOnly(t *testing.T) {
	f := newPolicyFixture(t)
	for _, name := range []string{"libgdk_pixbuf-2.0.so.0", "libpango-1.0.so.0", "libcairo.so.2", "libsoup-3.0.so.0"} {
		f.compile("usr/lib/"+name, name)
	}
	before := f.snapshot()
	report := f.run("check")
	expectStatus(t, report, "ready")
	if report["removedFiles"] != 0 || report["checkedELF"] != 9 {
		t.Fatalf("неверные счётчики: %s", policyJSON(report))
	}
	if !reflect.DeepEqual(f.snapshot(), before) {
		t.Fatal("check изменил AppDir")
	}
}

// Старый backend, GTK3/GDK3 и typelibs удаляются вместе; текущие aliases сохраняются.
func TestPolicyPruneRemovesSecondBackendAndPassesCheck(t *testing.T) {
	f := newPolicyFixture(t)
	f.addLegacy()
	// Старый GTK2 проверяет версионную границу, а не только одно наблюдавшееся имя файла.
	f.compile("usr/lib/libgtk-x11-2.0.so.0", "libgtk-x11-2.0.so.0")
	if err := os.MkdirAll(f.path("usr/lib/gtk-2.0/modules"), 0o755); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(f.path("usr/lib/gtk-2.0/modules/old-module.txt"), []byte("old module"), 0o644); err != nil {
		t.Fatal(err)
	}
	alias := f.path("usr/lib/libgtk-4.so")
	f.symlink("libgtk-4.so.1", alias)
	core, _ := os.ReadFile(f.path("usr/lib/libgtk-4.so.1"))
	expectStatus(t, f.run("check"), "error")
	report := f.run("prune")
	expectStatus(t, report, "ready")
	if report["removedFiles"].(int) <= 10 || report["removedBytes"].(int64) <= 0 {
		t.Fatalf("удалено слишком мало: %s", policyJSON(report))
	}
	if !slices.Contains(report["removedPaths"].([]string), "usr/lib/webkit2gtk-4.1") {
		t.Fatalf("каталог старого backend не удалён: %s", policyJSON(report))
	}
	if data, err := os.ReadFile(alias); !isSymlink(alias) || err != nil || string(data) != string(core) {
		t.Fatal("alias текущей библиотеки повреждён")
	}
	expectStatus(t, f.run("check"), "ready")
}

// Копия GStreamer удаляется, хотя WebKit её требует: зависимость разрешится системной библиотекой.
func TestPolicyPruneRemovesBundledGStreamerUsedByWebKit(t *testing.T) {
	f := newPolicyFixture(t)
	core := f.compile("usr/lib/libgstreamer-1.0.so.0", "libgstreamer-1.0.so.0")
	app := f.compile("usr/lib/libgstapp-1.0.so.0", "libgstapp-1.0.so.0", core)
	f.compile("usr/lib/gtk-4.0/4.0.0/media/libmedia-gstreamer.so", "", core, app)
	webkit := f.path("usr/lib/libwebkitgtk-6.0.so.4")
	if err := os.Remove(webkit); err != nil {
		t.Fatal(err)
	}
	f.compile("usr/lib/libwebkitgtk-6.0.so.4", "libwebkitgtk-6.0.so.4", core, app)
	f.compile("usr/lib/libgstreamer-like.so", "libgstreamer-like.so")
	bundled := f.run("check")
	expectStatus(t, bundled, "error")
	if !strings.Contains(bundled["error"].(string), "GStreamer") {
		t.Fatalf("ошибка не называет GStreamer: %s", policyJSON(bundled))
	}
	report := f.run("prune")
	expectStatus(t, report, "ready")
	removed := slices.Sorted(slices.Values(report["removedPaths"].([]string)))
	if !reflect.DeepEqual(removed, []string{"usr/lib/libgstapp-1.0.so.0", "usr/lib/libgstreamer-1.0.so.0"}) {
		t.Fatalf("неверный состав удалённого: %v", removed)
	}
	for _, kept := range []string{webkit, f.path("usr/lib/gtk-4.0/4.0.0/media/libmedia-gstreamer.so"), f.path("usr/lib/libgstreamer-like.so")} {
		if _, err := os.Stat(kept); err != nil {
			t.Fatalf("удалён нужный файл %s", kept)
		}
	}
	expectStatus(t, f.run("check"), "ready")
}

// Переименование файла не скрывает библиотеку со старым DT_SONAME.
func TestPolicyMaskedLegacySonameIsRejected(t *testing.T) {
	f := newPolicyFixture(t)
	f.compile("usr/lib/unrelated-name.so", "libwebkit2gtk-4.1.so.0")
	report := f.run("check")
	expectStatus(t, report, "error")
	if !strings.Contains(report["error"].(string), "unrelated-name.so") {
		t.Fatalf("ошибка не называет файл: %s", policyJSON(report))
	}
}

// DT_NEEDED старого стека отклоняется, даже если его файл замаскирован или отсутствует.
func TestPolicyMaskedNeededDependencyIsRejected(t *testing.T) {
	f := newPolicyFixture(t)
	library := f.compile("usr/lib/innocent.so", "libgtk-3.so.0")
	f.compile("usr/bin/current-app", "", library)
	if err := os.Remove(library); err != nil {
		t.Fatal(err)
	}
	report := f.run("check")
	expectStatus(t, report, "error")
	for _, part := range []string{"usr/bin/current-app", "libgtk-3.so.0"} {
		if !strings.Contains(report["error"].(string), part) {
			t.Fatalf("ошибка не содержит %s: %s", part, policyJSON(report))
		}
	}
}

// Старая библиотека не удаляется, пока любой остающийся ELF ещё требует её SONAME.
func TestPolicyPruneRefusesLiveDependencyWithoutMutation(t *testing.T) {
	f := newPolicyFixture(t)
	library := f.compile("usr/lib/libgtk-3.so.0", "libgtk-3.so.0")
	f.compile("usr/bin/still-needs-gtk3", "", library)
	before := f.snapshot()
	report := f.run("prune")
	expectStatus(t, report, "error")
	for _, part := range []string{"usr/bin/still-needs-gtk3", "libgtk-3.so.0"} {
		if !strings.Contains(report["error"].(string), part) {
			t.Fatalf("ошибка не содержит %s: %s", part, policyJSON(report))
		}
	}
	if report["removedFiles"] != 0 || !reflect.DeepEqual(f.snapshot(), before) {
		t.Fatal("отказ prune изменил AppDir")
	}
}

// Удаление legacy directory symlink удаляет лишь ссылку; нейтральная внешняя ссылка не обходится.
func TestPolicyDirectorySymlinksDoNotEscapeAppDir(t *testing.T) {
	f := newPolicyFixture(t)
	outside := filepath.Join(f.base, "Не AppDir")
	if err := os.Mkdir(outside, 0o755); err != nil {
		t.Fatal(err)
	}
	sentinel := filepath.Join(outside, "libgtk-3.so.0")
	if err := os.WriteFile(sentinel, []byte("external must survive"), 0o644); err != nil {
		t.Fatal(err)
	}
	legacyLink, neutralLink := f.path("usr/lib/webkit2gtk-4.1"), f.path("usr/lib/other-components")
	f.symlink(outside, legacyLink)
	f.symlink(outside, neutralLink)
	report := f.run("prune")
	expectStatus(t, report, "ready")
	if isSymlink(legacyLink) || !isSymlink(neutralLink) {
		t.Fatal("неверно обработаны ссылки на внешний каталог")
	}
	if data, _ := os.ReadFile(sentinel); string(data) != "external must survive" {
		t.Fatal("изменён внешний файл")
	}
	if report["removedBytes"].(int64) != 0 || report["removedFiles"] != 1 {
		t.Fatalf("неверные счётчики: %s", policyJSON(report))
	}
}

// Удаление по SONAME включает нейтрально названный alias, чтобы не оставлять битую ссылку.
func TestPolicyAliasOfMaskedLegacyIsRemovedWithoutDanglingLink(t *testing.T) {
	f := newPolicyFixture(t)
	f.compile("usr/lib/masked-payload.so", "libjavascriptcoregtk-4.1.so.0")
	alias := f.path("usr/lib/alternate-name.so")
	f.symlink("masked-payload.so", alias)
	report := f.run("prune")
	expectStatus(t, report, "ready")
	if !slices.Contains(report["removedPaths"].([]string), "usr/lib/alternate-name.so") || isSymlink(alias) {
		t.Fatalf("alias не удалён: %s", policyJSON(report))
	}
}

// Два текущих backend тоже неоднозначны: одного корректного набора рядом недостаточно.
func TestPolicyDuplicateCurrentHelpersAreRejected(t *testing.T) {
	f := newPolicyFixture(t)
	f.compile("opt/second/webkitgtk-6.0/WebKitWebProcess", "")
	report := f.run("check")
	expectStatus(t, report, "error")
	if !strings.Contains(report["error"].(string), "ровно один") {
		t.Fatalf("неверная ошибка: %s", policyJSON(report))
	}
}

// Финализатор обязан остановиться на политике до чтения offset исходного образа и создания
// результата: грязный AppDir не доходит даже до запуска runtime/toolchain.
func TestFinalizerRejectsLegacyBeforeTouchingRuntimeOrTools(t *testing.T) {
	f := newPolicyFixture(t)
	f.addLegacy()
	if _, err := exec.LookPath("go"); err != nil {
		t.Skip("финализатору нужен go в PATH")
	}
	script, err := filepath.Abs("../finalize-appimage.sh")
	if err != nil {
		t.Fatal(err)
	}
	output := filepath.Join(f.base, "must-not-exist.AppImage")
	command := exec.Command("bash", script, f.root, filepath.Join(f.base, "no-original.AppImage"), output, filepath.Join(f.base, "no-linuxdeploy"))
	var stdout, stderr strings.Builder
	command.Stdout, command.Stderr = &stdout, &stderr
	if err := command.Run(); err == nil {
		t.Fatal("финализатор принял legacy AppDir")
	}
	var report map[string]any
	if err := json.Unmarshal([]byte(stdout.String()), &report); err != nil {
		t.Fatalf("stdout не JSON: %v\n%s\n%s", err, stdout.String(), stderr.String())
	}
	if report["status"] != "error" || !strings.Contains(report["error"].(string), "legacy") {
		t.Fatalf("неверный отчёт: %v", report)
	}
	if strings.Contains(stderr.String(), "no-original") {
		t.Fatal("финализатор обратился к исходному образу")
	}
	for _, path := range []string{output, filepath.Join(f.base, "toolchain")} {
		if _, err := os.Lstat(path); err == nil {
			t.Fatalf("создан %s", path)
		}
	}
}
