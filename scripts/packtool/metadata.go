package main

// Квитанция Linux-поставки: SHA и измерения файла, ревизия Git и состав без абсолютных путей
// сборочной машины. Рядом с поставкой пишутся <файл>.build.json и <файл>.sha256, тот же JSON
// печатается в stdout. Для AppImage квитанция включает повторную проверку runtime policy:
// неподходящий GTK/WebKit не может получить квитанцию даже при ручном вызове.

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
)

// externalComponents — компоненты, которые ставятся из приложения и не входят в поставку.
var externalComponents = []string{"ffmpeg", "ort-cpu", "voc-ft", "ctc-ru", "ctc-vocab"}

// fileDigest потоково считает SHA-256: размер поставки не определяет потребление памяти.
func fileDigest(path string) (string, error) {
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

// commandText выполняет команду и возвращает stdout; ненулевой код — ошибка.
func commandText(name string, arguments ...string) (string, error) {
	output, err := exec.Command(name, arguments...).Output()
	if err != nil {
		return "", fmt.Errorf("%s %s: %w", name, strings.Join(arguments, " "), err)
	}
	return string(output), nil
}

// gitState — ревизия HEAD и наличие незакоммиченных изменений рабочей копии.
func gitState() (string, bool, error) {
	revision, err := commandText("git", "rev-parse", "HEAD")
	if err != nil {
		return "", false, err
	}
	status, err := commandText("git", "status", "--porcelain")
	if err != nil {
		return "", false, err
	}
	return strings.TrimSpace(revision), status != "", nil
}

// unpackedBytes — сумма размеров обычных файлов дерева без symlink и без обхода ссылок на каталоги.
func unpackedBytes(root string) (int64, error) {
	var total int64
	err := filepath.WalkDir(root, func(path string, entry fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		if entry.Type().IsRegular() {
			info, err := entry.Info()
			if err != nil {
				return err
			}
			total += info.Size()
		}
		return nil
	})
	return total, err
}

// kernelRelease — release ядра сборочной машины (как uname -r).
func kernelRelease() (string, error) {
	data, err := os.ReadFile("/proc/sys/kernel/osrelease")
	if err != nil {
		return "", err
	}
	return strings.TrimRight(string(data), "\n"), nil
}

// writeReceipt пишет <файл>.build.json и <файл>.sha256 и печатает квитанцию.
func writeReceipt(image string, receipt object, sha string) error {
	data := encodeJSON(receipt, jsonOptions{indent: 2})
	if err := os.WriteFile(image+".build.json", append(data, '\n'), 0o666); err != nil {
		return err
	}
	line := fmt.Sprintf("%s  %s\n", sha, filepath.Base(image))
	if err := os.WriteFile(image+".sha256", []byte(line), 0o666); err != nil {
		return err
	}
	_, err := os.Stdout.Write(append(data, '\n'))
	return err
}

// metadataCommand — `metadata IMAGE APPDIR LINUXDEPLOY VERSION` для AppImage или
// `metadata --deb PACKAGE TREE VERSION` для deb. Запускается из корня репозитория.
func metadataCommand(arguments []string) error {
	deb := len(arguments) > 0 && arguments[0] == "--deb"
	var image, appdir, tool, version string
	switch {
	case deb && len(arguments) == 4:
		image, appdir, version = arguments[1], arguments[2], arguments[3]
	case !deb && len(arguments) == 4:
		image, appdir, tool, version = arguments[0], arguments[1], arguments[2], arguments[3]
	default:
		return errors.New("использование: packtool metadata IMAGE APPDIR LINUXDEPLOY VERSION | --deb PACKAGE TREE VERSION")
	}
	revision, dirty, err := gitState()
	if err != nil {
		return err
	}
	// В deb библиотек нет: GTK4/WebKitGTK 6.0 приходят зависимостями пакета.
	var policy policyReport
	if !deb {
		policy = executePolicy("check", appdir)
		if policy.status() != "ready" {
			os.Stderr.Write(append(policyJSON(policy), '\n'))
			return errors.New("runtime policy не пройдена; квитанция не записана")
		}
	}
	kernel, err := kernelRelease()
	if err != nil {
		return err
	}
	info, err := os.Stat(image)
	if err != nil {
		return err
	}
	sha, err := fileDigest(image)
	if err != nil {
		return err
	}
	unpacked, err := unpackedBytes(appdir)
	if err != nil {
		return err
	}
	toolInfo := object{{"wails", "3.0.0"}}
	if !deb {
		toolSHA, err := fileDigest(tool)
		if err != nil {
			return err
		}
		toolInfo = append(toolInfo, field{"linuxdeploySHA256", toolSHA})
	}
	receipt := object{
		{"version", version}, {"revision", revision}, {"dirty", dirty},
		{"platform", "linux/amd64"}, {"minimumOS", "Ubuntu 24.04 / glibc 2.39"},
		{"kernel", kernel}, {"file", filepath.Base(image)},
		{"bytes", info.Size()}, {"sha256", sha},
		{"unpackedBytes", unpacked}, {"tool", toolInfo},
	}
	if deb {
		depends, err := commandText("dpkg-deb", "--field", image, "Depends")
		if err != nil {
			return err
		}
		receipt = append(receipt, field{"depends", strings.TrimSpace(depends)})
	} else {
		receipt = append(receipt, field{"runtimePolicy", map[string]any(policy)})
	}
	receipt = append(receipt, field{"externalComponents", externalComponents})
	return writeReceipt(image, receipt, sha)
}
