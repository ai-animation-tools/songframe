package project

import (
	"os"
	"path/filepath"
	"strings"
	"syscall"
)

// markerPath — маркер папки проекта относительно её корня. По нему FileProblem узнаёт, что
// путь лежит внутри проекта.
var markerPath = filepath.Join("plan", "project.json")

// FileProblem — понятный русский текст файловой ошибки errno над path, когда path лежит в папке
// проекта: путь показан от папки проекта, за описанием следует подсказка, что сделать. Папка
// проекта — ближайший предок path (или сам path) с маркером plan/project.json; отсутствие самого
// маркера тоже описывается. Для пути вне проекта (временная папка, выбранная пользователем папка
// экспорта, внешняя программа) и errno без пользовательского смысла ok = false: вызывающий
// оставляет технический текст. Текст начинается со строчной буквы, потому что его продолжают
// префиксы вроде «Ошибка: » и «Не удалось прочитать X: ».
func FileProblem(errno syscall.Errno, path string) (text string, ok bool) {
	if path == "" {
		return "", false
	}
	relative, marker, found := projectRelative(path)
	if !found {
		return "", false
	}
	shown := "«" + relative + "»"
	switch errno {
	case syscall.ENOENT:
		switch {
		case marker:
			return "в выбранной папке нет " + shown + ": это не папка проекта SongFrame или её файл удалён. Выберите папку проекта заново.", true
		case strings.HasPrefix(relative, "source/"):
			return "в папке проекта нет " + shown + ". Если файл удалили или переместили, верните его на место или выберите заново.", true
		default:
			return "в папке проекта нет " + shown + ". Если файл удалили или переместили вне приложения, верните его на место или повторите шаг, который его создаёт.", true
		}
	case syscall.EACCES, syscall.EPERM:
		return "нет доступа к " + shown + " в папке проекта. Проверьте права на папку проекта и её файлы.", true
	case syscall.EISDIR:
		return shown + " в папке проекта — папка, а нужен файл. Переименуйте или уберите эту папку.", true
	case syscall.ENOTDIR:
		return "путь " + shown + " в папке проекта проходит через файл там, где нужна папка. Переименуйте или уберите этот файл.", true
	case syscall.ENOSPC:
		return "нет места на диске для " + shown + " в папке проекта. Освободите место и повторите.", true
	case syscall.EROFS:
		return "папка проекта доступна только для чтения, запись " + shown + " невозможна. Перенесите проект на диск, доступный для записи.", true
	case syscall.ELOOP:
		return "слишком много уровней символических ссылок в " + shown + " в папке проекта. Проверьте ссылки внутри папки проекта.", true
	case syscall.EIO:
		return "ошибка ввода-вывода при работе с " + shown + " в папке проекта. Проверьте диск.", true
	case syscall.EEXIST:
		return shown + " в папке проекта уже существует.", true
	case syscall.ENOTEMPTY:
		return "папка " + shown + " в папке проекта не пуста.", true
	}
	return "", false
}

// ShownPath — путь для сообщения пользователю: внутри папки проекта — «путь от неё» с пометкой
// «в папке проекта», иначе path как есть (папка вне проекта, временный файл).
func ShownPath(path string) string {
	if relative, _, found := projectRelative(path); found {
		return "«" + relative + "» в папке проекта"
	}
	return path
}

// projectRelative — путь path от папки проекта с разделителем «/». marker = path и есть
// отсутствующий маркер <папка>/plan/project.json (папку проекта тогда не по чему узнать, и она
// определяется по самому пути). Корень проекта сам по себе (пустой относительный путь) не
// описывается: found = false.
func projectRelative(path string) (relative string, marker, found bool) {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return "", false, false
	}
	for dir := absolute; ; {
		if info, err := os.Stat(filepath.Join(dir, markerPath)); err == nil && info.Mode().IsRegular() {
			local, err := filepath.Rel(dir, absolute)
			if err != nil || local == "." {
				return "", false, false
			}
			return filepath.ToSlash(local), local == markerPath, true
		}
		parent := filepath.Dir(dir)
		if parent == dir {
			break
		}
		dir = parent
	}
	if strings.HasSuffix(absolute, string(filepath.Separator)+markerPath) {
		return filepath.ToSlash(markerPath), true, true
	}
	return "", false, false
}
