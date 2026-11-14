// Package filedigest считает SHA-256 файлов проекта с кэшем в памяти процесса.
//
// Статус проекта сверяет хеши принятых клипов и входов аниматика при каждом обращении; в готовом
// клипе это сотни мегабайт MP4. Запись кэша действительна, пока
// не изменилась identity файла (устройство, inode, размер, mtime и ctime в наносекундах), поэтому
// замена файла с прежними размером и mtime всё равно видна по inode и ctime. На диск проекта кэш
// ничего не пишет; доступ из нескольких горутин защищён мьютексом.
//
// Здесь же распознаётся текстовый указатель Git LFS (lfs.go): если клип склонирован без
// `git lfs pull`, вместо медиа лежит указатель, и сверка SHA-256 исходников и комплектов планов
// сообщает об этом понятным текстом, а не общим «файл изменён».
package filedigest

import (
	"crypto/sha256"
	"encoding/hex"
	"io"
	"os"
	"sync"
)

// limit ограничивает размер кэша: при переполнении он очищается целиком, чтобы не
// копить пути давно закрытых проектов.
const limit = 4096

type entry struct {
	identity string
	digest   string
}

var (
	mutex sync.Mutex
	cache = map[string]entry{}
)

// File возвращает hex SHA-256 обычного файла (ссылки разыменовываются). ok=false, если пути нет,
// это не файл или чтение не удалось; запись кэша для такого пути удаляется.
func File(path string) (string, bool) {
	info, err := os.Stat(path)
	if err != nil || !info.Mode().IsRegular() {
		forget(path)
		return "", false
	}
	id := identity(info)
	mutex.Lock()
	cached, found := cache[path]
	mutex.Unlock()
	if found && cached.identity == id {
		return cached.digest, true
	}
	digest, err := compute(path)
	if err != nil {
		forget(path)
		return "", false
	}
	mutex.Lock()
	if len(cache) >= limit {
		cache = map[string]entry{}
	}
	cache[path] = entry{identity: id, digest: digest}
	mutex.Unlock()
	return digest, true
}

// compute читает файл потоком: память не зависит от размера клипа.
func compute(path string) (string, error) {
	file, err := os.Open(path)
	if err != nil {
		return "", err
	}
	defer file.Close()
	hash := sha256.New()
	if _, err := io.Copy(hash, file); err != nil {
		return "", err
	}
	return hex.EncodeToString(hash.Sum(nil)), nil
}

func forget(path string) {
	mutex.Lock()
	delete(cache, path)
	mutex.Unlock()
}
