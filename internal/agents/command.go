package agents

import (
	"os"
	"path/filepath"
	"regexp"
	"runtime"
	"strings"
)

// Поиск и запуск CLI агентов без shell в Linux и Windows.
//
// Платформа передаётся явно (значения process.platform: "linux", "win32", …), чтобы поведение
// Windows — расширения .exe/.cmd, регистр имён переменных, разворачивание обёрток npm — проверялось
// и на Linux. Разделитель PATH, абсолютность и склейка путей берутся у ОС, на которой работает
// приложение. Окружение — срез "КЛЮЧ=значение" формата os.Environ.

// hostPlatform — runtime.GOOS в обозначениях process.platform (Windows — win32).
func hostPlatform() string {
	if runtime.GOOS == "windows" {
		return "win32"
	}
	return runtime.GOOS
}

// environmentKey — имя переменной в окружении: в Windows имена не различают регистр, и у копии
// окружения ключ остаётся как есть (обычно Path). Без совпадения возвращается name.
func environmentKey(env []string, name, platform string) string {
	if platform != "win32" {
		return name
	}
	for _, entry := range env {
		key, _, _ := strings.Cut(entry, "=")
		if strings.EqualFold(key, name) {
			return key
		}
	}
	return name
}

// environmentValue возвращает значение переменной (с учётом регистра Windows) и признак наличия.
func environmentValue(env []string, name, platform string) (string, bool) {
	key := environmentKey(env, name, platform)
	for _, entry := range env {
		if k, value, ok := strings.Cut(entry, "="); ok && k == key {
			return value, true
		}
	}
	return "", false
}

// setEnvironment заменяет переменную key или добавляет её в конец; остальные записи не меняются.
func setEnvironment(env []string, key, value string) []string {
	result := make([]string, 0, len(env)+1)
	replaced := false
	for _, entry := range env {
		if k, _, _ := strings.Cut(entry, "="); k == key {
			if !replaced {
				result = append(result, key+"="+value)
				replaced = true
			}
			continue
		}
		result = append(result, entry)
	}
	if !replaced {
		result = append(result, key+"="+value)
	}
	return result
}

// searchDirectories — каталоги PATH. Относительные записи пропускаются, чтобы не запустить
// одноимённый файл из папки проекта.
func searchDirectories(env []string, platform string) []string {
	value, ok := environmentValue(env, "PATH", platform)
	if !ok {
		return []string{}
	}
	directories := []string{}
	for _, directory := range strings.Split(value, string(os.PathListSeparator)) {
		if filepath.IsAbs(directory) {
			directories = append(directories, directory)
		}
	}
	return directories
}

// isExecutable — обычный файл; вне Windows также с правом исполнения для текущего пользователя.
// В Windows признака исполнения нет: программу определяет расширение.
func isExecutable(path, platform string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		return false
	}
	return platform == "win32" || canExecute(path)
}

// FindExecutable ищет программу по имени в каталогах PATH. В Windows нативная установка даёт
// .exe, глобальная установка npm — обёртку .cmd; .exe предпочтителен в пределах каталога.
func FindExecutable(name string, env []string, platform string) (string, bool) {
	names := []string{name}
	if platform == "win32" {
		names = []string{name + ".exe", name + ".cmd"}
	}
	for _, directory := range searchDirectories(env, platform) {
		for _, file := range names {
			candidate := filepath.Join(directory, file)
			if isExecutable(candidate, platform) {
				return candidate, true
			}
		}
	}
	return "", false
}

// Command — программа и аргументы для internal/process после разворачивания обёрток.
type Command struct {
	File string
	Args []string
}

// shimTarget — цель обёртки cmd-shim из npm: последний путь от %dp0% перед %*.
var shimTarget = regexp.MustCompile(`"%dp0%\\([^"\r\n]+)"` + jsSpace + `+%\*`)

// AgentCommand превращает найденную программу в прямой запуск без cmd.exe. Windows запускает .cmd
// только через интерпретатор команд с другими правилами разбора аргументов, поэтому обёртка npm
// разворачивается в вызов её цели: скрипт — через node.exe рядом с обёрткой или из PATH,
// программа .exe/.com — как есть. Непонятная обёртка остаётся без изменений и даёт штатную
// ошибку запуска; вне Windows команда не меняется.
func AgentCommand(name string, args []string, env []string, platform string) Command {
	path := name
	if platform == "win32" && !filepath.IsAbs(name) {
		// Поиск Windows по голому имени дописывает только .exe и .com, поэтому имя разрешаем здесь.
		if found, ok := FindExecutable(name, env, platform); ok {
			path = found
		}
	}
	extension := strings.ToLower(filepath.Ext(path))
	if platform != "win32" || (extension != ".cmd" && extension != ".bat") {
		return Command{File: path, Args: args}
	}
	shim, err := os.ReadFile(path)
	if err != nil {
		return Command{File: path, Args: args}
	}
	matches := shimTarget.FindAllStringSubmatch(string(shim), -1)
	if len(matches) == 0 {
		return Command{File: path, Args: args}
	}
	target := matches[len(matches)-1][1]
	script := filepath.Join(append([]string{filepath.Dir(path)}, strings.Split(target, `\`)...)...)
	switch strings.ToLower(filepath.Ext(script)) {
	case ".exe", ".com":
		return Command{File: script, Args: args}
	}
	// Как и сама обёртка, предпочитаем node.exe рядом с ней, иначе node из PATH.
	node := filepath.Join(filepath.Dir(path), "node.exe")
	if !isExecutable(node, platform) {
		found, ok := FindExecutable("node", env, platform)
		if !ok {
			found = "node.exe"
		}
		node = found
	}
	return Command{File: node, Args: append([]string{script}, args...)}
}

// systemDirectories — стандартные каталоги программ Linux, которых может не быть в PATH процесса,
// запущенного с рабочего стола.
var systemDirectories = []string{"/usr/local/bin", "/usr/bin", "/bin"}

// windowsDirectories — каталоги установок агентов Windows: %APPDATA%\npm у глобального npm и
// Node.js в Program Files для его обёрток (~/.local/bin нативного Claude добавляется отдельно).
func windowsDirectories(env []string) []string {
	directories := []string{}
	if appData, ok := environmentValue(env, "APPDATA", "win32"); ok && appData != "" {
		directories = append(directories, filepath.Join(appData, "npm"))
	}
	if programFiles, ok := environmentValue(env, "ProgramFiles", "win32"); ok && programFiles != "" {
		directories = append(directories, filepath.Join(programFiles, "nodejs"))
	}
	return directories
}

// AgentEnvironment — окружение CLI: PATH процесса, ~/.local/bin (нативная установка Claude) и
// системные каталоги платформы без повторов и относительных записей. Графическое приложение часто
// не наследует PATH терминала. Переменная PATH остаётся одна: вторая запись рядом с Path сделала бы
// поиск дочернего процесса в Windows неоднозначным. system nil — каталоги платформы по умолчанию.
func AgentEnvironment(env []string, home string, system []string, platform string) []string {
	extra := system
	if extra == nil {
		if platform == "win32" {
			extra = windowsDirectories(env)
		} else {
			extra = systemDirectories
		}
	}
	seen := map[string]bool{}
	directories := []string{}
	for _, directory := range append(append(searchDirectories(env, platform), filepath.Join(home, ".local", "bin")), extra...) {
		if seen[directory] || !filepath.IsAbs(directory) {
			continue
		}
		seen[directory] = true
		directories = append(directories, directory)
	}
	key := environmentKey(env, "PATH", platform)
	return setEnvironment(env, key, strings.Join(directories, string(os.PathListSeparator)))
}

// defaultEnvironment — окружение приложения с каталогами агентов и домашний каталог пользователя.
func defaultEnvironment() ([]string, string) {
	home, _ := os.UserHomeDir()
	return AgentEnvironment(os.Environ(), home, nil, hostPlatform()), home
}
