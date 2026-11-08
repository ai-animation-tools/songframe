package main

// Лицензионные материалы поставки: LICENSE проекта, MIT-уведомление Forktopus для bootstrap
// AppImage, copyright исходных Debian-пакетов вложенных библиотек, лицензии Go-модулей из
// module cache и runtime-зависимостей frontend. Состав каталога — часть поставки, поэтому
// обход и перезапись файлов детерминированы: порядок зависимостей frontend берётся из
// package.json, как при разрешении модулей Node.

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// noticesCommand — `notices APPDIR [linux|windows|deb]`, запускается из корня репозитория.
// Каталог уведомлений: licenses/ для Windows, usr/share/doc/songframe/ для Linux.
func noticesCommand(arguments []string) error {
	if len(arguments) < 1 || len(arguments) > 2 {
		return errors.New("использование: packtool notices APPDIR [linux|windows|deb]")
	}
	appdir, platform := arguments[0], "linux"
	if len(arguments) == 2 {
		platform = arguments[1]
	}
	notices := filepath.Join(appdir, "usr/share/doc/songframe")
	if platform == "windows" {
		notices = filepath.Join(appdir, "licenses")
	}
	if err := os.MkdirAll(notices, 0o777); err != nil {
		return err
	}
	if err := copyFile("LICENSE", filepath.Join(notices, "LICENSE")); err != nil {
		return err
	}
	// Bootstrap адаптирован из Forktopus; полный MIT notice сохранён в заголовке исходника.
	if platform == "linux" {
		source, err := os.ReadFile("scripts/appimage-bootstrap/main_linux.go")
		if err != nil {
			return err
		}
		text := strings.ReplaceAll(strings.ReplaceAll(string(source), "\r\n", "\n"), "\r", "\n")
		header, _, _ := strings.Cut(text, "package main")
		if err := os.WriteFile(filepath.Join(notices, "Forktopus-MIT.txt"), []byte(header), 0o666); err != nil {
			return err
		}
	}
	packages, err := systemPackages(filepath.Join(appdir, "usr/lib"))
	if err != nil {
		return err
	}
	for _, name := range packages {
		name, _, _ = strings.Cut(name, ":")
		copyright := filepath.Join("/usr/share/doc", name, "copyright")
		if isFile(copyright) {
			target := filepath.Join(notices, "system", name)
			if err := os.MkdirAll(target, 0o777); err != nil {
				return err
			}
			if err := copyFile(copyright, filepath.Join(target, "copyright")); err != nil {
				return err
			}
		}
	}
	// В deb системные библиотеки не вкладываются, а ставятся зависимостями пакета.
	if platform != "deb" {
		list := strings.Join(packages, "\n") + "\n"
		if err := os.WriteFile(filepath.Join(notices, "system-packages.txt"), []byte(list), 0o666); err != nil {
			return err
		}
	}
	if err := goNotices(notices); err != nil {
		return err
	}
	return frontendNotices(notices)
}

// systemPackages по именам вложенных .so находит владельцев исходных Debian-библиотек:
// relocation Wails не меняет их лицензию. Результат отсортирован; каталога может не быть.
func systemPackages(libraries string) ([]string, error) {
	found := map[string]bool{}
	files, err := walkPaths(libraries)
	if err != nil {
		return nil, err
	}
	for _, path := range files {
		name := filepath.Base(path)
		if !strings.Contains(name, ".so") || !isFile(path) {
			continue
		}
		// Код выхода не важен: dpkg-query сообщает об отсутствии владельца в stderr.
		output, _ := exec.Command("dpkg-query", "-S", "*/"+name).Output()
		for _, line := range strings.Split(string(output), "\n") {
			if owners, _, ok := strings.Cut(line, ": /"); ok {
				for _, owner := range strings.Split(owners, ", ") {
					found[owner] = true
				}
			}
		}
	}
	return sortedKeys(found), nil
}

// walkPaths перечисляет все пути под каталогом, не заходя в symlink на каталоги.
// Отсутствующий каталог даёт пустой список.
func walkPaths(root string) ([]string, error) {
	if _, err := os.Lstat(root); errors.Is(err, fs.ErrNotExist) {
		return nil, nil
	}
	var result []string
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if path != root {
			result = append(result, path)
		}
		return nil
	})
	return result, err
}

// isFile — путь ведёт к обычному файлу с учётом symlink.
func isFile(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.Mode().IsRegular()
}

// licenseName — файл лицензии, copying или notice по началу имени без учёта регистра.
func licenseName(name string) bool {
	lower := strings.ToLower(name)
	return strings.HasPrefix(lower, "license") || strings.HasPrefix(lower, "copying") || strings.HasPrefix(lower, "notice")
}

// copyLicenseFiles копирует файлы лицензий из каталога пакета в target.
func copyLicenseFiles(directory, target string, create bool) error {
	items, err := os.ReadDir(directory)
	if err != nil {
		return err
	}
	for _, item := range items {
		path := filepath.Join(directory, item.Name())
		if !licenseName(item.Name()) || !isFile(path) {
			continue
		}
		if create {
			if err := os.MkdirAll(target, 0o777); err != nil {
				return err
			}
		}
		if err := copyFile(path, filepath.Join(target, item.Name())); err != nil {
			return err
		}
	}
	return nil
}

// goNotices копирует лицензии всех зависимых Go-модулей из module cache в go/<module>/<version>.
func goNotices(notices string) error {
	output, err := exec.Command("go", "list", "-m", "-json", "all").Output()
	if err != nil {
		return fmt.Errorf("go list -m -json all: %w", err)
	}
	decoder := json.NewDecoder(bytes.NewReader(output))
	for {
		var module struct {
			Path, Version, Dir string
			Main               bool
		}
		if err := decoder.Decode(&module); err == io.EOF {
			return nil
		} else if err != nil {
			return err
		}
		if module.Dir == "" || module.Main {
			continue
		}
		target := filepath.Join(notices, "go", module.Path, module.Version)
		if err := copyLicenseFiles(module.Dir, target, true); err != nil {
			return err
		}
	}
}

// frontendNotices обходит только runtime dependencies frontend, а не все dev-инструменты
// node_modules, в порядке объявления в package.json.
func frontendNotices(notices string) error {
	root, err := filepath.Abs("frontend")
	if err != nil {
		return err
	}
	if root, err = filepath.EvalSymlinks(root); err != nil {
		return err
	}
	metadata, err := readOrderedJSON(filepath.Join(root, "package.json"))
	if err != nil {
		return err
	}
	dependencies, _ := metadata.get("dependencies")
	visited := map[string]bool{}
	for _, dependency := range dependencies.(object) {
		if err := frontendPackage(dependency.Key, root, notices, visited); err != nil {
			return err
		}
	}
	return nil
}

// readOrderedJSON читает JSON-объект с сохранением порядка ключей.
func readOrderedJSON(path string) (object, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, err
	}
	value, err := decodeOrdered(data)
	if err != nil {
		return nil, fmt.Errorf("%s: %w", path, err)
	}
	result, ok := value.(object)
	if !ok {
		return nil, fmt.Errorf("%s: ожидался JSON-объект", path)
	}
	return result, nil
}

// frontendPackage разрешает зависимость как Node — от ближайшего node_modules к корневому —
// и записывает её name/version/license и файлы лицензий в frontend/<name>. Один каталог
// пакета обходится один раз; одноимённые пакеты разных версий пишут в один каталог по порядку.
func frontendPackage(name, parent, notices string, visited map[string]bool) error {
	directory := parent
	for !isFile(filepath.Join(directory, "node_modules", name, "package.json")) {
		if directory == filepath.Dir(directory) {
			return fmt.Errorf("Не найдена frontend dependency %s", name)
		}
		directory = filepath.Dir(directory)
	}
	packageDir := filepath.Join(directory, "node_modules", name)
	if visited[packageDir] {
		return nil
	}
	visited[packageDir] = true
	metadata, err := readOrderedJSON(filepath.Join(packageDir, "package.json"))
	if err != nil {
		return err
	}
	summary := object{}
	for _, key := range []string{"name", "version", "license"} {
		value, _ := metadata.get(key)
		summary = append(summary, field{key, value})
	}
	target := filepath.Join(notices, "frontend", name)
	if err := os.MkdirAll(target, 0o777); err != nil {
		return err
	}
	data := append(encodeJSON(summary, jsonOptions{indent: 2, ensureASCII: true}), '\n')
	if err := os.WriteFile(filepath.Join(target, "package.json"), data, 0o666); err != nil {
		return err
	}
	if err := copyLicenseFiles(packageDir, target, false); err != nil {
		return err
	}
	dependencies, _ := metadata.get("dependencies")
	nested, _ := dependencies.(object)
	for _, dependency := range nested {
		if err := frontendPackage(dependency.Key, packageDir, notices, visited); err != nil {
			return err
		}
	}
	return nil
}

// copyFile копирует содержимое (по symlink — содержимое цели) в новый или усечённый файл
// с правами по умолчанию; права источника не переносятся.
func copyFile(source, target string) error {
	input, err := os.Open(source)
	if err != nil {
		return err
	}
	defer input.Close()
	output, err := os.OpenFile(target, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, 0o666)
	if err != nil {
		return err
	}
	if _, err := io.Copy(output, input); err != nil {
		output.Close()
		return err
	}
	return output.Close()
}
