package pycompat

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"sort"
	"strings"
)

// Операции pathlib CPython 3.12, от которых зависят тексты и порядок вывода инструментов:
// соединение и нормализация путей (без схлопывания «..»), relative_to с текстом ошибки,
// name/stem/suffix/with_suffix, resolve(strict=False) и glob одного уровня (с dot-файлами,
// как у pathlib, отсортированный или в порядке каталога, как scandir).

// isSeparator — разделитель компонентов пути (на Windows pathlib принимает оба).
func isSeparator(r rune) bool {
	return r == '/' || (runtime.GOOS == "windows" && r == '\\')
}

// cleanPath — str(Path(path)): повторные разделители и компоненты «.» убираются, «..» остаются.
func cleanPath(path string) string {
	volume := filepath.VolumeName(path)
	rest := path[len(volume):]
	root := ""
	if rest != "" && isSeparator(rune(rest[0])) {
		root = string(filepath.Separator)
		// POSIX сохраняет ровно два ведущих «//» (особый корень), три и больше — один.
		if runtime.GOOS != "windows" && strings.HasPrefix(rest, "//") && !strings.HasPrefix(rest, "///") {
			root = "//"
		}
	}
	parts := []string{}
	for _, part := range strings.FieldsFunc(rest, isSeparator) {
		if part != "." {
			parts = append(parts, part)
		}
	}
	result := volume + root + strings.Join(parts, string(filepath.Separator))
	if result == "" {
		return "."
	}
	return result
}

// JoinPath — Path(base) / part / …: абсолютная часть заменяет накопленный путь.
func JoinPath(base string, parts ...string) string {
	current := base
	for _, part := range parts {
		if filepath.IsAbs(part) || (runtime.GOOS != "windows" && strings.HasPrefix(part, "/")) {
			current = part
			continue
		}
		if part == "" {
			continue
		}
		current = current + string(filepath.Separator) + part
	}
	return cleanPath(current)
}

// pathParts — компоненты нормализованного пути (корень — отдельным первым элементом).
func pathParts(path string) []string {
	clean := cleanPath(path)
	volume := filepath.VolumeName(clean)
	rest := clean[len(volume):]
	parts := []string{}
	if rest != "" && isSeparator(rune(rest[0])) {
		trimmed := strings.TrimLeftFunc(rest, isSeparator)
		parts = append(parts, volume+rest[:len(rest)-len(trimmed)])
		rest = trimmed
	} else if volume != "" {
		parts = append(parts, volume)
	}
	if rest != "" && rest != "." {
		parts = append(parts, strings.FieldsFunc(rest, isSeparator)...)
	}
	return parts
}

// RelativeTo — str(Path(path).relative_to(base)): лексически, без разрешения ссылок.
// Путь вне base — ValueError с текстом Python 3.12.
func RelativeTo(path, base string) (string, error) {
	target, root := pathParts(path), pathParts(base)
	if len(target) < len(root) {
		return "", Raise(ValueError, "%s is not in the subpath of %s", Repr(cleanPath(path)), Repr(cleanPath(base)))
	}
	for index := range root {
		if target[index] != root[index] {
			return "", Raise(ValueError, "%s is not in the subpath of %s", Repr(cleanPath(path)), Repr(cleanPath(base)))
		}
	}
	rest := target[len(root):]
	if len(rest) == 0 {
		return ".", nil
	}
	return strings.Join(rest, string(filepath.Separator)), nil
}

// IsRelativeTo — Path.is_relative_to: лексическая проверка вложенности.
func IsRelativeTo(path, base string) bool {
	_, err := RelativeTo(path, base)
	return err == nil
}

// PathName — Path.name: последний компонент (у корня — пусто).
func PathName(path string) string {
	parts := pathParts(path)
	if len(parts) == 0 {
		return ""
	}
	last := parts[len(parts)-1]
	if len(parts) == 1 && (strings.IndexFunc(last, isSeparator) >= 0 || filepath.VolumeName(last) == last) {
		return ""
	}
	return last
}

// PathSuffix — Path.suffix: «.ext» последнего компонента (у «.name» и «name.» — пусто).
func PathSuffix(path string) string {
	name := Runes(PathName(path))
	for index := len(name) - 1; index >= 0; index-- {
		if name[index] == '.' {
			if index > 0 && index < len(name)-1 {
				return FromRunes(name[index:])
			}
			return ""
		}
	}
	return ""
}

// PathStem — Path.stem: имя без PathSuffix.
func PathStem(path string) string {
	name := PathName(path)
	return name[:len(name)-len(PathSuffix(path))]
}

// WithSuffix — Path.with_suffix(suffix) для непустого допустимого suffix.
func WithSuffix(path, suffix string) string {
	name := PathName(path)
	parent := filepath.Dir(cleanPath(path))
	stem := name[:len(name)-len(PathSuffix(path))]
	return JoinPath(parent, stem+suffix)
}

// ResolvePath — Path(path).resolve() без strict: абсолютный путь, ссылки разыменованы в
// существующей части, несуществующий хвост добавляется как есть (с лексическим «..»).
func ResolvePath(path string) string {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return path
	}
	rest := []string{}
	for current := absolute; ; current = filepath.Dir(current) {
		if resolved, err := filepath.EvalSymlinks(current); err == nil {
			return filepath.Join(append([]string{resolved}, rest...)...)
		}
		if filepath.Dir(current) == current {
			return absolute
		}
		rest = append([]string{filepath.Base(current)}, rest...)
	}
}

// IsDir — Path.is_dir(): каталог после разыменования ссылок.
func IsDir(path string) bool {
	info, err := os.Stat(path)
	return err == nil && info.IsDir()
}

// Exists — Path.exists(): путь существует после разыменования ссылок.
func Exists(path string) bool {
	_, err := os.Stat(path)
	return err == nil
}

// globPattern — шаблон одного компонента glob pathlib (fnmatch.translate): `*`, `?` и литералы;
// на Windows без учёта регистра. Dot-файлы не исключаются.
func globPattern(pattern string) *regexp.Regexp {
	var builder strings.Builder
	if runtime.GOOS == "windows" {
		builder.WriteString("(?i)")
	}
	builder.WriteString(`(?s)\A`)
	for _, r := range pattern {
		switch r {
		case '*':
			builder.WriteString(".*")
		case '?':
			builder.WriteString(".")
		default:
			builder.WriteString(regexp.QuoteMeta(string(r)))
		}
	}
	builder.WriteString(`\z`)
	return regexp.MustCompile(builder.String())
}

// sortKey — ключ сравнения путей pathlib: на Windows регистр не учитывается.
func sortKey(name string) string {
	if runtime.GOOS == "windows" {
		return strings.ToLower(name)
	}
	return name
}

// SortPaths — sorted(paths) pathlib по компонентам.
func SortPaths(paths []string) {
	sort.SliceStable(paths, func(a, b int) bool {
		left, right := pathParts(paths[a]), pathParts(paths[b])
		for index := 0; index < len(left) && index < len(right); index++ {
			if sortKey(left[index]) != sortKey(right[index]) {
				return sortKey(left[index]) < sortKey(right[index])
			}
		}
		return len(left) < len(right)
	})
}

// Glob — directory.glob(pattern) для шаблонов из компонентов без «**»: промежуточные компоненты
// совпадают только с каталогами, последний — с любым существующим путём (литерал проверяется
// exists()). Порядок — как у scandir (порядок каталога); sorted(...) вызывающего — SortPaths.
// Отсутствующий или нечитаемый каталог даёт пустой результат.
func Glob(directory, pattern string) []string {
	if !IsDir(directory) {
		return []string{}
	}
	parts := strings.Split(pattern, "/")
	current := []string{cleanPath(directory)}
	for index, part := range parts {
		last := index == len(parts)-1
		next := []string{}
		for _, base := range current {
			if !strings.ContainsAny(part, "*?[") {
				path := JoinPath(base, part)
				if (last && Exists(path)) || (!last && IsDir(path)) {
					next = append(next, path)
				}
				continue
			}
			matcher := globPattern(part)
			for _, name := range readDirNames(base) {
				if !matcher.MatchString(name) {
					continue
				}
				path := JoinPath(base, name)
				if !last && !IsDir(path) {
					continue
				}
				next = append(next, path)
			}
		}
		current = next
	}
	return current
}

// readDirNames — имена записей каталога в порядке файловой системы (как os.scandir).
func readDirNames(directory string) []string {
	handle, err := os.Open(directory)
	if err != nil {
		return nil
	}
	defer handle.Close()
	names, _ := handle.Readdirnames(-1)
	return names
}

// IterDir — Path.iterdir() в порядке каталога (sorted(...) вызывающего — SortPaths).
// Ошибка чтения — OSError Python.
func IterDir(directory string) ([]string, error) {
	handle, err := os.Open(directory)
	if err != nil {
		return nil, OSErrorFrom(err, directory)
	}
	defer handle.Close()
	names, err := handle.Readdirnames(-1)
	if err != nil {
		return nil, OSErrorFrom(err, directory)
	}
	result := make([]string, len(names))
	for index, name := range names {
		result[index] = JoinPath(directory, name)
	}
	return result, nil
}
