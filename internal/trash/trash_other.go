//go:build !linux && !windows

package trash

// move — корзина на других ОС не реализована: поставки SongFrame есть только для Linux и Windows.
func move(string) error { return ErrUnsupported }
