package main

// Политика runtime AppDir: в образе остаётся один backend GTK4/WebKitGTK 6.0, а GStreamer
// берётся из системы. Wails 3.0.0 копирует helpers обеих установленных ABI WebKit и вкладывает
// копию libgstreamer; prune удаляет лишнее только после проверки, что остающимся ELF оно не
// нужно, check повторяет ту же проверку перед упаковкой и для квитанции сборки. Файлы AppDir
// никогда не исполняются: динамическая граница ELF читается readelf, symlink не проходятся.

import (
	"bytes"
	"context"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"
)

var (
	// Проверяется версия GTK/WebKit, а не общее вхождение gtk/gdk: GdkPixbuf, Pango, Cairo
	// и libsoup могут быть нужны GTK4 и не входят в список удаления.
	legacyLibrary = regexp.MustCompile(`^(?:lib(?:gtk|gdk)-x11-2\.0|lib(?:gtk|gdk)-3|` +
		`libwebkit2gtk-4\.[0-9]+|libjavascriptcoregtk-4\.[0-9]+)\.so(?:\.[0-9]+)*$`)
	legacyDirectory = regexp.MustCompile(`^(?:gtk-[23]\.0|gdk-3\.0|webkit2?gtk-4\.[0-9]+)$`)
	legacyTypelib   = regexp.MustCompile(`^(?:(?:Gtk|Gdk|GdkX11|GdkWayland)-[23]\.0|` +
		`(?:WebKit2|WebKit2WebExtension|JavaScriptCore)-4\.[0-9]+)\.typelib$`)
	// Ядро GStreamer и библиотеки plugins-base берутся из системы вместе с плагинами. Вложенная
	// libgstreamer ищет плагины относительно себя (usr/lib/gstreamer-1.0 внутри образа), системные
	// не видит, и WebKitWebProcess падает при создании <audio>: нет appsink/autoaudiosink.
	systemGStreamer = regexp.MustCompile(`^libgst[a-z0-9_]*-1\.0\.so(?:\.[0-9]+)*$`)
	dynamicTag      = regexp.MustCompile(`\((NEEDED|SONAME)\).*?\[([^\]]+)\]`)
)

// requiredLibraries и requiredHelpers — обязательный текущий стек внутри AppDir.
var (
	requiredLibraries = []string{"libgtk-4.so.1", "libwebkitgtk-6.0.so.4", "libjavascriptcoregtk-6.0.so.1"}
	requiredHelpers   = []string{"WebKitWebProcess", "WebKitNetworkProcess"}
)

// policyError — отказ политики: состав непригоден, обходить проверку нельзя.
type policyError struct{ message string }

func (e *policyError) Error() string { return e.message }

// policyErrorf создаёт отказ политики с форматированным текстом.
func policyErrorf(format string, args ...any) error {
	return &policyError{fmt.Sprintf(format, args...)}
}

// entry — снимок одного пути без следования symlink; размер есть только у обычного файла.
type entry struct {
	kind   string // file, directory или symlink
	size   int64
	target string
}

// tree — снимок AppDir: пути относительно корня в порядке обхода сверху вниз (внутри каталога
// по имени) и их записи. Порядок определяет, какой путь назовёт сообщение об ошибке.
type tree struct {
	order   []string
	entries map[string]entry
}

// elfInfo — DT_NEEDED по порядку и первый DT_SONAME (пусто, если его нет).
type elfInfo struct {
	needed []string
	soname string
}

// posixName — последний компонент пути с POSIX-разбором: пустые и «.» компоненты
// пропускаются, «..» сохраняется; у пустой строки и «.» имени нет.
func posixName(value string) string {
	parts := posixParts(value)
	if len(parts) == 0 {
		return ""
	}
	return parts[len(parts)-1]
}

// posixParts — компоненты относительного пути без пустых и «.».
func posixParts(value string) []string {
	var parts []string
	for _, part := range strings.Split(value, "/") {
		if part != "" && part != "." {
			parts = append(parts, part)
		}
	}
	return parts
}

// posixParents — все родители относительного пути от ближайшего до «.».
func posixParents(value string) []string {
	parts := posixParts(value)
	var parents []string
	for i := len(parts) - 1; i > 0; i-- {
		parents = append(parents, strings.Join(parts[:i], "/"))
	}
	if len(parts) > 0 {
		parents = append(parents, ".")
	}
	return parents
}

// posixParent — непосредственный родитель относительного пути («.» для верхнего уровня).
func posixParent(value string) string {
	parents := posixParents(value)
	if len(parents) == 0 {
		return "."
	}
	return parents[0]
}

// legacyName распознаёт только явно старую ABI, typelib или каталог её runtime/helpers.
func legacyName(name string) bool {
	return legacyLibrary.MatchString(name) || legacyDirectory.MatchString(name) || legacyTypelib.MatchString(name)
}

// systemName распознаёт библиотеку GStreamer, которая должна разрешаться из системы.
func systemName(name string) bool { return systemGStreamer.MatchString(name) }

// removedName — путь удаляется политикой: старый backend или вложенная копия GStreamer.
func removedName(name string) bool { return legacyName(name) || systemName(name) }

// inventory снимает дерево AppDir, не заходя в symlink на каталоги и не читая их цели.
// Нечитаемый каталог — ошибка: непроверенный состав нельзя молча пропустить.
func inventory(root string) (tree, error) {
	result := tree{entries: map[string]entry{}}
	var walk func(directory, prefix string) error
	walk = func(directory, prefix string) error {
		items, err := os.ReadDir(directory)
		if err != nil {
			return err
		}
		names := make([]string, len(items))
		for i, item := range items {
			names[i] = item.Name()
		}
		sort.Strings(names)
		var subdirectories []string
		for _, name := range names {
			path := filepath.Join(directory, name)
			relative := prefix + name
			info, err := os.Lstat(path)
			if err != nil {
				return err
			}
			switch mode := info.Mode(); {
			case mode&fs.ModeSymlink != 0:
				target, err := os.Readlink(path)
				if err != nil {
					return err
				}
				result.entries[relative] = entry{kind: "symlink", target: target}
			case mode.IsDir():
				result.entries[relative] = entry{kind: "directory"}
				subdirectories = append(subdirectories, name)
			case mode.IsRegular():
				result.entries[relative] = entry{kind: "file", size: info.Size()}
			default:
				return policyErrorf("Неподдерживаемый тип файла в AppDir: %s", relative)
			}
			result.order = append(result.order, relative)
		}
		for _, name := range subdirectories {
			if err := walk(filepath.Join(directory, name), prefix+name+"/"); err != nil {
				return err
			}
		}
		return nil
	}
	return result, walk(root, "")
}

// sortedPaths — пути снимка по возрастанию.
func (t tree) sortedPaths() []string {
	paths := append([]string(nil), t.order...)
	sort.Strings(paths)
	return paths
}

// linkTarget лексически разрешает текст одной ссылки и возвращает путь внутри AppDir;
// ссылка наружу даёт ok=false. Каталог назначения не открывается.
func linkTarget(root, relative string, snapshot tree) (string, bool) {
	target := snapshot.entries[relative].target
	var absolute string
	if strings.HasPrefix(target, "/") {
		absolute = filepath.Clean(target)
	} else {
		absolute = filepath.Clean(root + "/" + relative + "/../" + target)
	}
	if absolute == root {
		return ".", true
	}
	if strings.HasPrefix(absolute, root+"/") {
		return absolute[len(root)+1:], true
	}
	return "", false
}

// realFile находит обычный файл по известным aliases, не открывая пути вне снимка.
func realFile(root, relative string, snapshot tree) (string, bool) {
	seen := map[string]bool{}
	for {
		item, known := snapshot.entries[relative]
		if !known || seen[relative] {
			return "", false
		}
		seen[relative] = true
		switch item.kind {
		case "file":
			return relative, true
		case "symlink":
			next, ok := linkTarget(root, relative, snapshot)
			if !ok {
				return "", false
			}
			relative = next
		default:
			return "", false
		}
	}
}

// inspectELFs читает DT_NEEDED/DT_SONAME всех обычных ELF; ошибка readelf останавливает рецепт.
func inspectELFs(root string, snapshot tree) (map[string]elfInfo, error) {
	result := map[string]elfInfo{}
	environment := append(os.Environ(), "LC_ALL=C")
	for _, relative := range snapshot.sortedPaths() {
		if snapshot.entries[relative].kind != "file" {
			continue
		}
		path := filepath.Join(root, relative)
		magic, err := readMagic(path)
		if err != nil {
			return nil, err
		}
		if !bytes.Equal(magic, []byte("\x7fELF")) {
			continue
		}
		ctx, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		command := exec.CommandContext(ctx, "readelf", "--dynamic", "--wide", path)
		command.Env = environment
		var stdout, stderr bytes.Buffer
		command.Stdout, command.Stderr = &stdout, &stderr
		err = command.Run()
		timedOut := ctx.Err() != nil
		cancel()
		var exit *exec.ExitError
		if errors.As(err, &exit) && !timedOut {
			message := []rune(strings.TrimSpace(stderr.String()))
			if len(message) > 400 {
				message = message[:400]
			}
			return nil, policyErrorf("Не удалось прочитать ELF %s: %s", relative, string(message))
		}
		if err != nil {
			return nil, err
		}
		info := elfInfo{needed: []string{}}
		sonameSeen := false
		for _, match := range dynamicTag.FindAllStringSubmatch(stdout.String(), -1) {
			if match[1] == "NEEDED" {
				info.needed = append(info.needed, match[2])
			} else if !sonameSeen {
				info.soname, sonameSeen = match[2], true
			}
		}
		result[relative] = info
	}
	return result, nil
}

// readMagic читает до четырёх первых байтов файла.
func readMagic(path string) ([]byte, error) {
	file, err := os.Open(path)
	if err != nil {
		return nil, err
	}
	defer file.Close()
	buffer := make([]byte, 4)
	count, err := io.ReadFull(file, buffer)
	if err != nil && !errors.Is(err, io.ErrUnexpectedEOF) && !errors.Is(err, io.EOF) {
		return nil, err
	}
	return buffer[:count], nil
}

// removalPaths находит legacy и вложенный GStreamer по имени и SONAME, затем добавляет
// содержимое удаляемых каталогов и все ссылки на удаляемое до неподвижной точки.
func removalPaths(root string, snapshot tree, elfs map[string]elfInfo) map[string]bool {
	removed := map[string]bool{}
	for relative := range snapshot.entries {
		if removedName(posixName(relative)) {
			removed[relative] = true
		}
	}
	for relative, info := range elfs {
		if removedName(posixName(info.soname)) {
			removed[relative] = true
		}
	}
	for changed := true; changed; {
		before := len(removed)
		for _, relative := range snapshot.order {
			for _, parent := range posixParents(relative) {
				if removed[parent] {
					removed[relative] = true
				}
			}
			if snapshot.entries[relative].kind == "symlink" {
				if target, ok := linkTarget(root, relative, snapshot); ok {
					for _, candidate := range append([]string{posixJoin(target)}, posixParents(target)...) {
						if removed[candidate] {
							removed[relative] = true
						}
					}
				}
			}
		}
		changed = before != len(removed)
	}
	return removed
}

// posixJoin нормализует относительный путь цели так же, как ключи снимка («.» для корня).
func posixJoin(value string) string {
	parts := posixParts(value)
	if len(parts) == 0 {
		return "."
	}
	return strings.Join(parts, "/")
}

// verifyDependencies до удаления отвергает остающийся ELF, которому нужна старая ABI или
// удаляемый alias. Зависимость от GStreamer допустима: она разрешится системной библиотекой.
func verifyDependencies(elfs map[string]elfInfo, removed map[string]bool) error {
	removedNames := map[string]bool{}
	for relative := range removed {
		removedNames[posixName(relative)] = true
	}
	for relative, info := range elfs {
		if removed[relative] && info.soname != "" {
			removedNames[info.soname] = true
		}
	}
	for _, relative := range sortedKeys(elfs) {
		if removed[relative] {
			continue
		}
		for _, dependency := range elfs[relative].needed {
			name := posixName(dependency)
			if systemName(name) {
				continue
			}
			if legacyName(name) || removedNames[name] {
				return policyErrorf("ELF %s всё ещё требует удаляемую legacy-зависимость %s; файлы не удалены", relative, dependency)
			}
		}
	}
	return nil
}

// sortedKeys — ключи map по возрастанию.
func sortedKeys[V any](values map[string]V) []string {
	keys := make([]string, 0, len(values))
	for key := range values {
		keys = append(keys, key)
	}
	sort.Strings(keys)
	return keys
}

// currentStack — подтверждённый текущий стек для отчёта.
type currentStack struct {
	libraries map[string]any
	backend   string
	helpers   []string
}

// verifyCurrent подтверждает настоящие ELF текущих библиотек и единственную пару WebKit helpers.
func verifyCurrent(root string, snapshot tree, elfs map[string]elfInfo, removed map[string]bool) (currentStack, error) {
	libraries := map[string]any{}
	for _, soname := range requiredLibraries {
		var matches []string
		for _, relative := range snapshot.order {
			if removed[relative] || posixName(relative) != soname {
				continue
			}
			target, ok := realFile(root, relative, snapshot)
			if ok && !removed[target] {
				if info, isELF := elfs[target]; isELF && info.soname == soname {
					matches = append(matches, relative)
				}
			}
		}
		if len(matches) == 0 {
			return currentStack{}, policyErrorf("В AppDir отсутствует пригодная библиотека GTK4/WebKitGTK 6: %s", soname)
		}
		sort.Strings(matches)
		libraries[soname] = matches
	}
	var backends []string
	for _, relative := range snapshot.order {
		if !removed[relative] && snapshot.entries[relative].kind == "directory" && posixName(relative) == "webkitgtk-6.0" {
			backends = append(backends, relative)
		}
	}
	if len(backends) != 1 {
		return currentStack{}, policyErrorf("В AppDir должен быть ровно один каталог backend webkitgtk-6.0")
	}
	backend := backends[0]
	helpers := []string{}
	for _, name := range requiredHelpers {
		var matches []string
		for _, relative := range snapshot.order {
			if !removed[relative] && posixName(relative) == name {
				matches = append(matches, relative)
			}
		}
		if len(matches) != 1 || posixParent(matches[0]) != backend {
			return currentStack{}, policyErrorf("Нужен единственный %s внутри %s", name, backend)
		}
		target, ok := realFile(root, matches[0], snapshot)
		if _, isELF := elfs[target]; !ok || !isELF || removed[target] {
			return currentStack{}, policyErrorf("WebKit helper не является внутренним ELF: %s", matches[0])
		}
		helpers = append(helpers, matches[0])
	}
	for _, relative := range snapshot.order {
		if !removed[relative] && posixName(relative) == "WebKitGPUProcess" && posixParent(relative) != backend {
			return currentStack{}, policyErrorf("Дополнительный WebKit helper находится вне %s: %s", backend, relative)
		}
	}
	return currentStack{libraries: libraries, backend: backend, helpers: helpers}, nil
}

// policyReport — результат одной политики; ключи записываются по алфавиту.
type policyReport map[string]any

// status возвращает итог политики: ready или error.
func (r policyReport) status() string { return r["status"].(string) }

// setStack переносит подтверждённый стек в отчёт.
func (r policyReport) setStack(stack currentStack) {
	r["libraries"] = stack.libraries
	r["webkitBackend"] = stack.backend
	r["helpers"] = stack.helpers
}

// executePolicy выполняет prune или check и возвращает отчёт, включая фактические удаления.
// Ошибка любого шага попадает в поле error, status остаётся error.
func executePolicy(action, appdir string) policyReport {
	report := policyReport{
		"action": action, "status": "error", "removedPaths": []string{}, "removedFiles": 0,
		"removedDirectories": 0, "removedBytes": int64(0), "checkedELF": 0,
	}
	if err := runPolicy(action, appdir, report); err != nil {
		report["error"] = err.Error()
	} else {
		report["status"] = "ready"
	}
	return report
}

// absolutePath дописывает относительный путь к текущему каталогу без лексического сокращения
// «..»: компоненты разрешает файловая система, как и при обычном открытии пути.
func absolutePath(value string) (string, error) {
	for len(value) > 1 && strings.HasSuffix(value, "/") {
		value = strings.TrimSuffix(value, "/")
	}
	if strings.HasPrefix(value, "/") {
		return value, nil
	}
	current, err := os.Getwd()
	if err != nil {
		return "", err
	}
	if value == "" || value == "." {
		return current, nil
	}
	return current + "/" + value, nil
}

// runPolicy — тело политики. Все проверки зависимостей завершаются до первого удаления;
// после prune дерево снимается заново и проверяется как отдельным check.
func runPolicy(action, appdir string, report policyReport) error {
	path, err := absolutePath(appdir)
	if err != nil {
		return err
	}
	if info, err := os.Lstat(path); err != nil || info.Mode()&fs.ModeSymlink != 0 || !info.IsDir() {
		return policyErrorf("APPDIR должен быть существующим каталогом, а не symlink")
	}
	root, err := filepath.EvalSymlinks(path)
	if err != nil {
		return err
	}
	snapshot, err := inventory(root)
	if err != nil {
		return err
	}
	elfs, err := inspectELFs(root, snapshot)
	if err != nil {
		return err
	}
	report["checkedELF"] = len(elfs)
	removed := removalPaths(root, snapshot, elfs)
	if action == "check" && len(removed) > 0 {
		return policyErrorf("В AppDir остался legacy GTK/WebKit или вложенный GStreamer: %s", strings.Join(sortedKeys(removed), ", "))
	}
	if err := verifyDependencies(elfs, removed); err != nil {
		return err
	}
	stack, err := verifyCurrent(root, snapshot, elfs, removed)
	if err != nil {
		return err
	}
	report.setStack(stack)
	if action != "prune" {
		return nil
	}
	// Ссылки удаляются как ссылки, реальные каталоги — только после известных детей через
	// rmdir, без рекурсивного следования: глубокие пути первыми, при равной глубине по имени.
	order := sortedKeys(removed)
	sort.SliceStable(order, func(i, j int) bool {
		return len(posixParts(order[i])) > len(posixParts(order[j]))
	})
	paths := []string{}
	for _, relative := range order {
		item := snapshot.entries[relative]
		target := filepath.Join(root, relative)
		if item.kind == "directory" {
			if err := removeDirectory(target); err != nil {
				return err
			}
			report["removedDirectories"] = report["removedDirectories"].(int) + 1
		} else {
			if err := removeFile(target); err != nil {
				return err
			}
			report["removedFiles"] = report["removedFiles"].(int) + 1
			report["removedBytes"] = report["removedBytes"].(int64) + item.size
		}
		paths = append(paths, relative)
		report["removedPaths"] = paths
	}
	snapshot, err = inventory(root)
	if err != nil {
		return err
	}
	elfs, err = inspectELFs(root, snapshot)
	if err != nil {
		return err
	}
	report["checkedELF"] = len(elfs)
	if remaining := removalPaths(root, snapshot, elfs); len(remaining) > 0 {
		return policyErrorf("После prune остался legacy или вложенный GStreamer: %s", strings.Join(sortedKeys(remaining), ", "))
	}
	if err := verifyDependencies(elfs, map[string]bool{}); err != nil {
		return err
	}
	stack, err = verifyCurrent(root, snapshot, elfs, map[string]bool{})
	if err != nil {
		return err
	}
	report.setStack(stack)
	return nil
}

// removeDirectory удаляет только пустой каталог (rmdir), никогда не рекурсивно.
func removeDirectory(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if !info.IsDir() {
		return &fs.PathError{Op: "rmdir", Path: path, Err: errors.New("not a directory")}
	}
	return os.Remove(path)
}

// removeFile удаляет файл или ссылку (unlink), но не каталог.
func removeFile(path string) error {
	info, err := os.Lstat(path)
	if err != nil {
		return err
	}
	if info.IsDir() {
		return &fs.PathError{Op: "unlink", Path: path, Err: errors.New("is a directory")}
	}
	return os.Remove(path)
}

// policyJSON — отчёт в виде, который печатает CLI и вкладывает квитанция AppImage.
func policyJSON(report policyReport) []byte {
	return encodeJSON(map[string]any(report), jsonOptions{indent: 2, sortKeys: true})
}

// runtimePolicyCommand — `runtime-policy prune|check APPDIR`: печатает один JSON-документ;
// ненулевой код делает нарушение политики фатальным для сборки.
func runtimePolicyCommand(arguments []string) int {
	if len(arguments) != 2 || (arguments[0] != "prune" && arguments[0] != "check") {
		fmt.Fprintln(os.Stderr, "Использование: packtool runtime-policy prune|check APPDIR")
		return 2
	}
	report := executePolicy(arguments[0], arguments[1])
	os.Stdout.Write(append(policyJSON(report), '\n'))
	if report.status() != "ready" {
		return 1
	}
	return 0
}
