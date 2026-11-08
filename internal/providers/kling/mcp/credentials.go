package mcp

import (
	"os"
	"path/filepath"
	"runtime"
	"time"

	"songframe/internal/toolrt"
)

// Записи входа: `<каталог состояния>/providers/kling/credentials.json` с полями client_id,
// access_token, refresh_token, expires_at (секунды Unix, 0 — срок неизвестен), token_endpoint,
// revocation_endpoint, resource, scope. Запись хранится словарём toolrt, чтобы порядок ключей
// и байты файла (JSON с отступом 2) совпадали с эталонами.

// CredentialsPath — путь записи входа в каталоге состояния, вне проекта и вне файлов
// официального CLI.
func (c *Client) CredentialsPath() string {
	return filepath.Join(c.StateDir, "providers", ProviderID, "credentials.json")
}

// ReadCredentials — запись с непустым access_token или nil. Отсутствующий,
// повреждённый файл и не-объект одинаково означают «нет входа».
func (c *Client) ReadCredentials() *toolrt.Dict {
	value, _ := toolrt.ReadJSON(c.CredentialsPath())
	record, ok := value.(*toolrt.Dict)
	if !ok || !toolrt.Truthy(record.Value("access_token")) {
		return nil
	}
	return record
}

// WriteCredentials — атомарная замена через временный файл с правами
// 0600 и явные права 0600 там, где ОС их поддерживает (в Windows права наследуются от каталога
// профиля пользователя).
func (c *Client) WriteCredentials(record *toolrt.Dict) error {
	path := c.CredentialsPath()
	if err := toolrt.WriteJSONAtomic(path, record); err != nil {
		return err
	}
	if runtime.GOOS != "windows" {
		if err := os.Chmod(path, 0o600); err != nil {
			return toolrt.OSErrorFrom(err, path)
		}
	}
	return nil
}

// lockWait — ожидание блокировки в Windows (в Linux flock ждёт без срока).
const lockWait = 60 * time.Second

// withCredentialsLock — межпроцессная блокировка файла credentials.lock
// рядом с записью. Ротируемый refresh token должен обновлять ровно один процесс; блокировка
// также сериализует горутины одного процесса, потому что каждая открывает файл заново
// (flock и LockFileEx действуют на открытое описание файла).
func (c *Client) withCredentialsLock(action func() error) error {
	path := filepath.Join(filepath.Dir(c.CredentialsPath()), "credentials.lock")
	if err := os.MkdirAll(filepath.Dir(path), 0o777); err != nil {
		return toolrt.OSErrorFrom(err, filepath.Dir(path))
	}
	file, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE|os.O_APPEND, 0o666)
	if err != nil {
		return toolrt.OSErrorFrom(err, path)
	}
	defer file.Close()
	if err := lockFile(file, lockWait); err != nil {
		return toolrt.OSErrorFrom(err, path)
	}
	defer unlockFile(file)
	return action()
}
