// Package trash перемещает файлы и папки в корзину ОС вместо безвозвратного удаления
// (shell.trashItem оригинала). Используется для локальных результатов, которые пользователь
// удаляет кнопкой: ошибка не удаляет данные, а оставляет их на месте.
package trash

import (
	"errors"
	"path/filepath"
)

// ErrUnsupported — на этой ОС корзина не поддерживается; данные не трогаются.
var ErrUnsupported = errors.New("корзина ОС недоступна на этой платформе")

// Move перемещает существующий файл или папку path в корзину текущего пользователя.
// Путь приводится к абсолютному: корзина хранит исходное место для восстановления.
func Move(path string) error {
	absolute, err := filepath.Abs(path)
	if err != nil {
		return err
	}
	return move(absolute)
}
