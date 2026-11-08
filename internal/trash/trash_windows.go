package trash

import (
	"fmt"
	"syscall"
	"unsafe"
)

// fileOperation — SHFILEOPSTRUCTW (shellapi.h) для amd64: естественное выравнивание Go
// совпадает с раскладкой Windows SDK на 64-битной платформе.
type fileOperation struct {
	window      uintptr
	function    uint32
	from        *uint16
	to          *uint16
	flags       uint16
	aborted     int32
	mappings    uintptr
	progressTop *uint16
}

const (
	foDelete          = 0x0003
	fofSilent         = 0x0004
	fofNoConfirmation = 0x0010
	fofAllowUndo      = 0x0040
	fofNoErrorUI      = 0x0400
	fofNoConfirmMkdir = 0x0200
)

var shFileOperation = syscall.NewLazyDLL("shell32.dll").NewProc("SHFileOperationW")

// move — удаление с FOF_ALLOWUNDO, то есть в корзину, без диалогов и окна прогресса.
// pFrom — список путей с двойным нулём в конце.
func move(path string) error {
	from, err := syscall.UTF16FromString(path)
	if err != nil {
		return err
	}
	from = append(from, 0)
	operation := fileOperation{function: foDelete, from: &from[0], flags: fofAllowUndo | fofNoConfirmation | fofNoErrorUI | fofSilent | fofNoConfirmMkdir}
	result, _, _ := shFileOperation.Call(uintptr(unsafe.Pointer(&operation)))
	if result != 0 {
		return fmt.Errorf("не удалось переместить в корзину (код %d)", result)
	}
	if operation.aborted != 0 {
		return fmt.Errorf("перемещение в корзину прервано")
	}
	return nil
}
