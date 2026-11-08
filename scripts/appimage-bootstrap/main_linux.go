// Адаптировано из Forktopus: scripts/appimage/main_linux.go.
// Источник: https://github.com/forktopus/forktopus; исходное разрешение MIT сохранено ниже.
/*
MIT License

Copyright (c) 2026 Forktopus contributors

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
*/

// Подготовка AppArmor выполняется до загрузки GTK/WebKit: иначе отказ
// user namespaces завершает процесс внутри C и не оставляет понятной ошибки.
package main

import (
	"crypto/sha256"
	"fmt"
	"os"
	"os/exec"
	"path/filepath"
	"slices"
	"strings"
)

const setupFlag = "--setup-apparmor"
const restart = 20

// Профиль относится к самому AppImage, а не к случайной точке FUSE.
// После exec разрешение наследуют AppRun, приложение и песочница WebKit.
func profile(image string) (string, string) {
	sum := sha256.Sum256([]byte(image))
	name := fmt.Sprintf("songframe-appimage-%x", sum[:])
	var path strings.Builder
	for _, c := range []byte(image) {
		if c == '/' || c == '.' || c == '-' || c == '_' || c >= '0' && c <= '9' || c >= 'a' && c <= 'z' || c >= 'A' && c <= 'Z' {
			path.WriteByte(c)
		} else {
			// Hex сохраняет точный путь: пробелы, AARE и @{переменные}
			// не должны превращаться в шаблон либо новые правила профиля.
			fmt.Fprintf(&path, `\x%02x`, c)
		}
	}
	body := fmt.Sprintf(`# Разрешение user namespaces для одного файла SongFrame AppImage.
# Общая политика AppArmor и песочница WebKit остаются включёнными.
abi <abi/4.0>,
profile %s "%s" flags=(unconfined) {
  userns,
}
`, name, path.String())
	return name, body
}

// Скрипт использует только системные программы: root не может читать helper
// из пользовательского FUSE mount. Аргументы передаются отдельно от кода sh.
const installScript = `set -eu
name=$1
case "$name" in songframe-appimage-*) ;; *) exit 1 ;; esac
suffix=${name#songframe-appimage-}
case "$suffix" in ''|*[!0-9a-f]*) exit 1 ;; esac
[ "${#suffix}" -eq 64 ]
[ "$(id -u)" -eq 0 ]
parser=/sbin/apparmor_parser
[ -x "$parser" ] || parser=/usr/sbin/apparmor_parser
umask 022
tmp=$(mktemp /etc/apparmor.d/.songframe-appimage.XXXXXX)
trap 'rm -f "$tmp"' EXIT HUP INT TERM
printf '%s' "$2" > "$tmp"
chmod 644 "$tmp"
"$parser" -r "$tmp"
mv -f "$tmp" "/etc/apparmor.d/$name"
`

// imagePath разрешает ссылки до постоянного пути исходного AppImage и проверяет
// сигнатуру типа 2, чтобы профиль не привязывался к временной точке FUSE.
func imagePath(raw string) (string, error) {
	if raw == "" {
		return "", fmt.Errorf("не найден путь APPIMAGE; запустите сам файл AppImage")
	}
	path, err := filepath.EvalSymlinks(raw)
	if err != nil {
		return "", err
	}
	path, err = filepath.Abs(path)
	if err != nil {
		return "", err
	}
	f, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer f.Close()
	header := make([]byte, 11)
	if _, err = f.ReadAt(header, 0); err != nil || string(header[:4]) != "\x7fELF" || string(header[8:11]) != "AI\x02" {
		return "", fmt.Errorf("файл не является AppImage типа 2: %s", path)
	}
	return path, nil
}

// probe проверяет именно bubblewrap, которым WebKit создаёт свою песочницу.
// Go Cloneflags с записью uid_map родительским процессом даёт ложный успех:
// Ubuntu может запретить такую же запись самому bwrap после перехода в userns.
func probe() error {
	return probeBubblewrap(exec.LookPath, func(program string, args ...string) error {
		return exec.Command(program, args...).Run()
	})
}

// probeBubblewrap отдельно разрешает системную программу и запускает минимальную песочницу.
// Она не меняет файлы или политику ОС; ошибка mapping запускает обычный диалог настройки.
func probeBubblewrap(lookPath func(string) (string, error), execute func(string, ...string) error) error {
	program, err := lookPath("bwrap")
	if err != nil {
		return fmt.Errorf("не найден bubblewrap для песочницы WebKit: %w", err)
	}
	return execute(program, "--unshare-user", "--uid", "0", "--gid", "0", "--ro-bind", "/", "/", "--", "/bin/true")
}

// restricted читает действующее ограничение Ubuntu без изменения sysctl.
// На системах без этого параметра дополнительная настройка не требуется.
func restricted() bool {
	data, err := os.ReadFile("/proc/sys/kernel/apparmor_restrict_unprivileged_userns")
	return err == nil && strings.TrimSpace(string(data)) == "1"
}

// notify сохраняет ошибку в stderr и по возможности показывает её через
// системный zenity, пока окружение bundled GTK ещё не установлено.
func notify(text string) {
	fmt.Fprintln(os.Stderr, text)
	if bin, err := exec.LookPath("zenity"); err == nil {
		_ = exec.Command(bin, "--error", "--title=SongFrame", "--no-markup", "--text="+text).Run()
	}
}

// commandLineOnly отделяет команды, которые завершаются до создания WebKit.
// Компонентный smoke работает с файлами и inference; GUI --smoke проходит
// обычную подготовку, поскольку ему нужна действующая песочница WebKit.
func commandLineOnly(args []string) bool {
	for _, arg := range args {
		if arg == "--help" || arg == "-h" || arg == "--version" ||
			arg == "--component-smoke-input" || strings.HasPrefix(arg, "--component-smoke-input=") ||
			arg == "--component-smoke-report" || strings.HasPrefix(arg, "--component-smoke-report=") {
			return true
		}
	}
	return false
}

// run обрабатывает внутреннюю команду дочерней проверки и запускает подготовку
// через независимые от GTK проверки, пригодные для подмены в тестах.
func run(args []string) int {
	if len(args) == 1 && args[0] == "--probe-userns" {
		return 0
	}
	return prepare(args, restricted, probe)
}

// prepare запрашивает согласие только когда Ubuntu запрещает user namespaces.
// Код restart требует повторного exec исходного AppImage для применения профиля;
// повторная неудача завершается ошибкой и не создаёт цикл запросов пароля.
func prepare(args []string, isRestricted func() bool, checkUserns func() error) int {
	if commandLineOnly(args) {
		return 0
	}
	explicit := len(args) == 1 && args[0] == setupFlag
	if !explicit && (!isRestricted() || checkUserns() == nil) {
		return 0
	}
	if !explicit && os.Getenv("SONGFRAME_APPIMAGE_SETUP_RETRY") == "1" {
		notify("После настройки AppArmor user namespaces всё ещё недоступны. Запуск отменён; проверьте ограничения системы.")
		return 1
	}
	image, err := imagePath(os.Getenv("APPIMAGE"))
	if err != nil {
		notify("Не удалось настроить запуск SongFrame: " + err.Error())
		return 1
	}
	message := "Ubuntu запрещает песочнице WebKit создавать user namespaces. Для запуска SongFrame нужен профиль AppArmor только для этого файла AppImage. Система попросит пароль администратора. Настроить запуск?"
	if !explicit {
		// Автозапуск не должен открывать запрос пароля при входе в систему.
		if slices.Contains(args, "--hidden") {
			fmt.Fprintln(os.Stderr, "SongFrame: требуется настройка AppArmor; запустите AppImage вручную.")
			return 1
		}
		bin, err := exec.LookPath("zenity")
		if err != nil {
			fmt.Fprintf(os.Stderr, "SongFrame: требуется профиль AppArmor. Выполните: '%s' %s\n", strings.ReplaceAll(image, "'", "'\\''"), setupFlag)
			return 1
		}
		if exec.Command(bin, "--question", "--title=Запуск SongFrame", "--no-markup", "--text="+message, "--ok-label=Настроить", "--cancel-label=Отмена").Run() != nil {
			return 1
		}
	}
	name, body := profile(image)
	cmd := exec.Command("pkexec", "/bin/sh", "-c", installScript, "songframe-apparmor", name, body)
	cmd.Stdin, cmd.Stdout, cmd.Stderr = os.Stdin, os.Stdout, os.Stderr
	if err := cmd.Run(); err != nil {
		notify("Настройка AppArmor не выполнена. Запуск отменён; повторите запуск AppImage для новой попытки.")
		return 1
	}
	if explicit {
		fmt.Println("Профиль AppArmor настроен. Запустите SongFrame обычным способом.")
		return 0
	}
	return restart
}

// main возвращает AppRun результат подготовки, не загружая GTK/WebKit.
func main() { os.Exit(run(os.Args[1:])) }
