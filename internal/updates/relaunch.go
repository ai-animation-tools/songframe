package updates

import (
	"os"
	"os/exec"
	"strconv"
	"strings"

	"songframe-go/internal/process"
)

// RelaunchEnvironment — окружение нового AppImage без следов прежнего монтирования.
// AppRun дописывает пути точки монтирования в PATH, XDG_DATA_DIRS, GIO и др.; новый
// процесс с ними искал бы библиотеки в исчезнувшем каталоге. APPIMAGE/APPDIR/ARGV0/OWD
// задаёт среда запуска нового файла сама.
func RelaunchEnvironment(environment []string) []string {
	mount := ""
	for _, entry := range environment {
		if value, ok := strings.CutPrefix(entry, "APPDIR="); ok {
			mount = value
		}
	}
	result := []string{}
	for _, entry := range environment {
		key, value, ok := strings.Cut(entry, "=")
		if !ok {
			continue
		}
		switch key {
		case "APPIMAGE", "APPDIR", "ARGV0", "OWD":
			continue
		}
		if mount == "" || !strings.Contains(value, mount) {
			result = append(result, entry)
			continue
		}
		rest := []string{}
		for _, part := range strings.Split(value, ":") {
			if part != "" && !strings.HasPrefix(part, mount) {
				rest = append(rest, part)
			}
		}
		if len(rest) > 0 {
			result = append(result, key+"="+strings.Join(rest, ":"))
		}
	}
	return result
}

// RelaunchArgs — аргументы bash: дождаться выхода pid, закрыть унаследованные дескрипторы и
// запустить AppImage с аргументами args (кнопка обновления их не передаёт, проверка поставки
// передаёт --smoke). GTK/WebKit открывают файлы без CLOEXEC; без закрытия старый AppImage
// оставался бы смонтирован до закрытия новой версии.
func RelaunchArgs(pid int, appImage string, args ...string) []string {
	script := strings.Join([]string{
		`while kill -0 "$1" 2>/dev/null; do sleep 0.2; done`,
		`for fd in /proc/$$/fd/*; do fd=${fd##*/}; [ "$fd" -gt 2 ] && eval "exec $fd<&-"; done 2>/dev/null`,
		`pid=$1; shift`,
		`exec "$@"`,
	}, "\n")
	return append([]string{"-c", script, "songframe-relaunch", strconv.Itoa(pid), appImage}, args...)
}

// RelaunchAppImage запускает системный bash, который откроет новый AppImage после выхода
// этого процесса. Помощник отделён от приложения и переживает его завершение.
func RelaunchAppImage(appImage string, args ...string) error {
	command := exec.Command("/bin/bash", RelaunchArgs(os.Getpid(), appImage, args...)...)
	command.Env = RelaunchEnvironment(os.Environ())
	return process.StartDetached(command)
}

// LaunchInstaller запускает установщик Windows с обычным окном, отдельно от приложения.
func LaunchInstaller(file string) error {
	return process.StartDetached(exec.Command(file))
}
