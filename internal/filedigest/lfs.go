package filedigest

import (
	"bytes"
	"io"
	"os"
)

// lfsPointerPrefix — первая строка текстового указателя Git LFS (спецификация v1). Такой файл
// лежит в папке клипа вместо медиа, если репозиторий склонирован без `git lfs pull`.
const lfsPointerPrefix = "version https://git-lfs.github.com/spec/v1"

// lfsPointerLimit — по спецификации указатель меньше 1024 байт; файлы крупнее не читаются, поэтому
// проверка не замедляет сверку настоящих медиа.
const lfsPointerLimit = 1024

// IsLFSPointer сообщает, что path — обычный файл-указатель Git LFS, а не само содержимое.
// Отсутствующий, нечитаемый, крупный файл и каталог дают false: их разбирает вызывающий.
func IsLFSPointer(path string) bool {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() || info.Size() >= lfsPointerLimit || info.Size() < int64(len(lfsPointerPrefix)) {
		return false
	}
	file, err := os.Open(path)
	if err != nil {
		return false
	}
	defer file.Close()
	head := make([]byte, len(lfsPointerPrefix)+1)
	count, _ := io.ReadFull(file, head)
	head = head[:count]
	if !bytes.HasPrefix(head, []byte(lfsPointerPrefix)) {
		return false
	}
	// После версии — перевод строки (или конец файла): «spec/v10» указателем не считается.
	return len(head) == len(lfsPointerPrefix) || head[len(lfsPointerPrefix)] == '\n' || head[len(lfsPointerPrefix)] == '\r'
}

// LFSPointerText — понятная ошибка вместо несовпадения SHA-256: display — путь файла, как его
// показывает вызывающий (обычно относительно папки проекта).
func LFSPointerText(display string) string {
	return "Файл " + display + " — указатель Git LFS, а не само содержимое. Выполните в папке проекта git lfs pull."
}

// LFSPointerProblem — текст LFSPointerText, если файл path оказался указателем Git LFS; ok=false —
// это не указатель, и вызывающий сообщает о несовпадении хеша своим текстом. Вызывается только
// после несовпадения SHA-256, поэтому обычная сверка лишнего чтения не делает.
func LFSPointerProblem(path, display string) (text string, ok bool) {
	if !IsLFSPointer(path) {
		return "", false
	}
	return LFSPointerText(display), true
}
