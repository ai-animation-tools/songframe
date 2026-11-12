package productionworkflow

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"path/filepath"
	"regexp"
	"strings"

	"songframe/internal/dynvalue"
)

// packageFolder — отдельный пакет plan/batches/<имя> или plan/awaiting/<имя> относительно проекта.
var packageFolder = regexp.MustCompile(`^plan/(batches|awaiting)/[^/]+$`)

// digestHex — SHA-256 текста или байтов в hex.
func digestHex(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// isText сообщает, что value — непустая после trim строка без NUL.
func isText(value any) bool {
	text, ok := value.(string)
	return ok && dynvalue.Trim(text) != "" && !strings.Contains(text, "\x00")
}

// isOptionalText — строка, возможно пустая, без нулевых символов.
func isOptionalText(value any) bool {
	text, ok := value.(string)
	return ok && !strings.Contains(text, "\x00")
}

// outside — относительный путь выходит из корня (`..`, `../…` или абсолютный).
func outside(local string) bool {
	local = filepath.ToSlash(local)
	return local == ".." || strings.HasPrefix(local, "../") || dynvalue.IsAbs(local)
}

// rel — путь относительно проекта с прямыми разделителями: ключи снимка и allowedPaths одинаковы
// в Linux и Windows.
func rel(project, path string) string {
	return filepath.ToSlash(dynvalue.Relative(project, path))
}

// ProductionPath возвращает путь value внутри проекта root
// (относительный — от root). Отклоняет пути вне проекта и пути, чей ближайший существующий
// родитель через ссылку ведёт наружу: запись в пакет не должна уйти за пределы проекта.
// Возвращает абсолютный путь без разыменования ссылок; сам файл может не существовать.
func ProductionPath(root, value string) (string, error) {
	if !isText(value) {
		return "", errors.New(textPathRequired)
	}
	full := dynvalue.Resolve(root, value)
	if outside(dynvalue.Relative(root, full)) {
		return "", errors.New(textPathOutsideProject(value))
	}
	parent := full
	for !dynvalue.Exists(parent) {
		next := dynvalue.Resolve(parent, "..")
		if next == parent {
			return "", errors.New(textParentMissing)
		}
		parent = next
	}
	realRoot, err := dynvalue.Realpath(root)
	if err != nil {
		return "", err
	}
	realParent, err := dynvalue.Realpath(parent)
	if err != nil {
		return "", err
	}
	if outside(dynvalue.Relative(realRoot, realParent)) {
		return "", errors.New(textLinkOutsideProject(value))
	}
	return full, nil
}

// PackagePath — ProductionPath, который указывает ровно на отдельный пакет
// plan/batches/<имя> или plan/awaiting/<имя>. Иначе — packageFolderRequired.
func PackagePath(project, path string) (string, error) {
	target, err := ProductionPath(project, path)
	if err != nil {
		return "", err
	}
	if !packageFolder.MatchString(rel(project, target)) {
		return "", errors.New(textPackageFolderRequired)
	}
	return target, nil
}

// nextPackage — первый свободный plan/batches/<план>-attempt-NN.
func nextPackage(project, shot string) string {
	for number := 1; ; number++ {
		path := filepath.Join(project, "plan", "batches", shot+"-attempt-"+twoDigits(number))
		if !dynvalue.Exists(path) {
			return path
		}
	}
}

// twoDigits — десятичная запись числа, дополненная нулём слева до двух знаков.
func twoDigits(number int) string {
	text := dynvalue.NumberToString(float64(number))
	if len(text) < 2 {
		return "0" + text
	}
	return text
}
