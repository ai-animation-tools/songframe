//go:build windows

package components

import "golang.org/x/sys/windows"

// availableSpace получает свободные байты выбранного тома без запуска внешней программы.
func availableSpace(directory string) (uint64, error) {
	path, err := windows.UTF16PtrFromString(directory)
	if err != nil {
		return 0, err
	}
	var available uint64
	err = windows.GetDiskFreeSpaceEx(path, &available, nil, nil)
	return available, err
}
