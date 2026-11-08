package main

// Подготовка и статическая проверка Windows-поставки на Linux. Windows-код при этом не
// исполняется: PE-заголовок, импорты и ресурсы читаются из файла и objdump, состав NSIS —
// после распаковки 7z во временный каталог. Итог — квитанция <установщик>.build.json и
// <установщик>.sha256 рядом с установщиком.

import (
	"archive/zip"
	"bytes"
	"encoding/binary"
	"errors"
	"fmt"
	"io"
	"os"
	"os/exec"
	"path/filepath"
	"regexp"
	"strings"
)

// vcRuntimeDLLs — ровно DLL Visual C++ runtime, которые импортирует onnxruntime.dll
// (manifest.json компонента, abi.dependencies); кладутся рядом с songframe.exe.
var vcRuntimeDLLs = []string{"msvcp140.dll", "msvcp140_1.dll", "vcruntime140.dll", "vcruntime140_1.dll"}

// windowsInfoCommand — `windows-info VERSION NUMERIC OUT`: свойства версии PE для
// `wails3 generate syso` (ProductVersion — версия выпуска, file_version — четыре числа).
func windowsInfoCommand(arguments []string) error {
	if len(arguments) != 3 {
		return errors.New("использование: packtool windows-info VERSION NUMERIC OUT")
	}
	version, numeric, output := arguments[0], arguments[1], arguments[2]
	info := object{
		{"fixed", object{{"file_version", numeric}}},
		{"info", object{{"0419", object{
			{"ProductVersion", version}, {"CompanyName", "SongFrame"},
			{"FileDescription", "SongFrame"},
			{"LegalCopyright", "© 2026 Yarkov Aleksey"}, {"ProductName", "SongFrame"},
			{"OriginalFilename", "songframe.exe"},
		}}}},
	}
	return os.WriteFile(output, encodeJSON(info, jsonOptions{indent: -1}), 0o666)
}

// extractVCRuntimeCommand — `extract-vcruntime ARCHIVE DIR`: копирует DLL runtime и его
// условия распространения из закреплённого по SHA-256 zip-архива msvc-runtime без изменений.
func extractVCRuntimeCommand(arguments []string) error {
	if len(arguments) != 2 {
		return errors.New("использование: packtool extract-vcruntime ARCHIVE DIR")
	}
	archive, err := zip.OpenReader(arguments[0])
	if err != nil {
		return err
	}
	defer archive.Close()
	files := map[string]string{"LICENSE": "msvc_runtime-14.51.36231.dist-info/licenses/LICENSE"}
	order := append([]string(nil), vcRuntimeDLLs...)
	for _, name := range vcRuntimeDLLs {
		files[name] = "msvc_runtime-14.51.36231.data/data/Scripts/" + name
	}
	order = append(order, "LICENSE")
	for _, name := range order {
		data, err := readZipMember(&archive.Reader, files[name])
		if err != nil {
			return err
		}
		if err := os.WriteFile(filepath.Join(arguments[1], name), data, 0o666); err != nil {
			return err
		}
	}
	return nil
}

// readZipMember читает один элемент архива по точному имени.
func readZipMember(archive *zip.Reader, name string) ([]byte, error) {
	for _, file := range archive.File {
		if file.Name != name {
			continue
		}
		reader, err := file.Open()
		if err != nil {
			return nil, err
		}
		defer reader.Close()
		return io.ReadAll(reader)
	}
	return nil, fmt.Errorf("в архиве нет %s", name)
}

// checkFailed — нарушение состава Windows-поставки.
type checkFailed string

func (c checkFailed) Error() string { return string(c) }

// require возвращает нарушение с сообщением, если условие ложно.
func require(condition bool, message string) error {
	if condition {
		return nil
	}
	return checkFailed(message)
}

var dllName = regexp.MustCompile(`DLL Name:\s*(\S+)`)

// checkPE не принимает консольный exe или другую архитектуру за Windows GUI amd64 и
// допускает только системные импорты (kernel32 и UCRT); возвращает список импортов.
func checkPE(path string, data []byte) ([]string, error) {
	if len(data) < 0x40 {
		return nil, errors.New("файл слишком мал для PE")
	}
	offset := int(binary.LittleEndian.Uint32(data[0x3c:]))
	slice := func(start, length int) []byte {
		if start < 0 || start > len(data) {
			return nil
		}
		return data[start:min(start+length, len(data))]
	}
	if err := require(bytes.HasPrefix(data, []byte("MZ")) && bytes.Equal(slice(offset, 4), []byte("PE\x00\x00")), "Нет PE signature"); err != nil {
		return nil, err
	}
	word := func(at int) (uint16, error) {
		value := slice(at, 2)
		if len(value) != 2 {
			return 0, errors.New("PE-заголовок обрезан")
		}
		return binary.LittleEndian.Uint16(value), nil
	}
	for _, check := range []struct {
		at       int
		expected uint16
		message  string
	}{
		{offset + 4, 0x8664, "Нужен AMD64"},
		{offset + 24, 0x20b, "Нужен PE32+"},
		{offset + 24 + 68, 2, "Нужен Windows GUI subsystem"},
	} {
		value, err := word(check.at)
		if err != nil {
			return nil, err
		}
		if err := require(value == check.expected, check.message); err != nil {
			return nil, err
		}
	}
	sections, err := commandText("objdump", "-h", path)
	if err != nil {
		return nil, err
	}
	if err := require(strings.Contains(sections, ".rsrc"), "Отсутствуют icon/manifest resources"); err != nil {
		return nil, err
	}
	importsText, err := commandText("objdump", "-p", path)
	if err != nil {
		return nil, err
	}
	imports := []string{}
	for _, match := range dllName.FindAllStringSubmatch(importsText, -1) {
		imports = append(imports, match[1])
	}
	for _, name := range imports {
		lower := strings.ToLower(name)
		if err := require(lower == "kernel32.dll" || strings.HasPrefix(lower, "api-ms-win-crt-"), "Неподтверждённая native dependency: "+name); err != nil {
			return nil, err
		}
	}
	if err := require(bytes.Contains(data, []byte("tools.songframe.desktop")) && bytes.Contains(data, []byte("asInvoker")), "Нет отдельного app ID/asInvoker manifest"); err != nil {
		return nil, err
	}
	return imports, nil
}

// payload — распакованный установщик: все пути под корнем без обхода ссылок на каталоги.
type payload struct {
	root  string
	paths []string
}

// matching — пути, чей хвост из компонентов равен pattern; «*» в начале последнего
// компонента означает любое начало имени.
func (p payload) matching(pattern string) []string {
	var result []string
	for _, path := range p.paths {
		relative, _ := filepath.Rel(p.root, path)
		if suffix, ok := strings.CutPrefix(pattern, "*"); ok {
			if strings.HasSuffix(filepath.Base(relative), suffix) {
				result = append(result, path)
			}
			continue
		}
		if relative == pattern || strings.HasSuffix(relative, "/"+pattern) {
			result = append(result, path)
		}
	}
	return result
}

// checkInstaller распаковывает NSIS и сверяет состав: тот же exe, WebView2 bootstrapper,
// app-local VC++ runtime рядом с exe без vc_redist, лицензии, uninstaller и отсутствие ML.
// Возвращает суммарный размер распакованных файлов.
func checkInstaller(installer, binaryPath string) (int64, error) {
	directory, err := os.MkdirTemp("", "songframe-nsis-")
	if err != nil {
		return 0, err
	}
	defer os.RemoveAll(directory)
	extract := exec.Command("7z", "x", "-y", "-o"+directory, installer)
	extract.Stderr = os.Stderr
	if err := extract.Run(); err != nil {
		return 0, fmt.Errorf("7z: %w", err)
	}
	paths, err := walkPaths(directory)
	if err != nil {
		return 0, err
	}
	content := payload{root: directory, paths: paths}
	binarySHA, err := fileDigest(binaryPath)
	if err != nil {
		return 0, err
	}
	candidates := content.matching("songframe.exe")
	same := false
	if len(candidates) == 1 {
		candidateSHA, err := fileDigest(candidates[0])
		if err != nil {
			return 0, err
		}
		same = candidateSHA == binarySHA
	}
	if err := require(same, "В NSIS другой exe"); err != nil {
		return 0, err
	}
	checks := []error{require(len(content.matching("MicrosoftEdgeWebview2Setup.exe")) > 0, "Нет WebView2 bootstrapper")}
	// ORT импортирует VC++ runtime; DLL лежат рядом с exe, отдельного vc_redist нет.
	for _, name := range vcRuntimeDLLs {
		found := content.matching(name)
		checks = append(checks, require(len(found) == 1 && filepath.Dir(found[0]) == filepath.Dir(candidates[0]), name+" не рядом с songframe.exe"))
	}
	checks = append(checks,
		require(len(content.matching("vc_redist.x64.exe")) == 0, "Лишний vc_redist в пакете"),
		require(len(content.matching("msvc-runtime/LICENSE")) > 0, "Нет условий распространения VC++ runtime"),
		require(len(content.matching("uninstall.exe")) > 0, "Нет uninstaller"),
		require(len(content.matching("LICENSE")) > 0, "Нет лицензий"),
		require(len(content.matching("*.onnx")) == 0 && len(content.matching("onnxruntime.dll")) == 0, "ML попал в базовый пакет"),
	)
	for _, err := range checks {
		if err != nil {
			return 0, err
		}
	}
	var total int64
	for _, path := range paths {
		if info, err := os.Stat(path); err == nil && info.Mode().IsRegular() {
			total += info.Size()
		}
	}
	return total, nil
}

// checkWindowsCommand — `check-windows EXE INSTALLER VERSION IMAGE`: проверка PE/CGO и
// состава NSIS, затем квитанция. Запускается из корня репозитория (ревизия Git).
func checkWindowsCommand(arguments []string) error {
	if len(arguments) != 4 {
		return errors.New("использование: packtool check-windows EXE INSTALLER VERSION IMAGE")
	}
	binaryPath, installer, version, image := arguments[0], arguments[1], arguments[2], arguments[3]
	data, err := os.ReadFile(binaryPath)
	if err != nil {
		return err
	}
	imports, err := checkPE(binaryPath, data)
	if err != nil {
		return err
	}
	buildInfo, err := commandText("go", "version", "-m", binaryPath)
	if err != nil {
		return err
	}
	for _, required := range []string{"CGO_ENABLED=1", "GOOS=windows", "GOARCH=amd64", "github.com/microsoft/onnxruntime/go"} {
		if err := require(strings.Contains(buildInfo, required), "Не подтверждён "+required); err != nil {
			return err
		}
	}
	// Обновление из приложения сравнивает выпуски по версии, вшитой в бинарник через -X.
	// -trimpath не сохраняет ldflags в build info, поэтому ищем саму строку версии.
	if err := require(bytes.Contains(data, []byte(version)), "В exe не вшита версия packaging/VERSION"); err != nil {
		return err
	}
	payloadBytes, err := checkInstaller(installer, binaryPath)
	if err != nil {
		return err
	}
	revision, dirty, err := gitState()
	if err != nil {
		return err
	}
	installerInfo, err := os.Stat(installer)
	if err != nil {
		return err
	}
	installerSHA, err := fileDigest(installer)
	if err != nil {
		return err
	}
	applicationSHA, err := fileDigest(binaryPath)
	if err != nil {
		return err
	}
	crossImage, err := commandText("docker", "image", "inspect", image, "--format", "{{.Id}}")
	if err != nil {
		return err
	}
	receipt := object{
		{"version", version}, {"platform", "windows/amd64"}, {"minimumOS", "Windows 10/11 x64"},
		{"revision", revision}, {"dirty", dirty},
		{"file", filepath.Base(installer)}, {"bytes", installerInfo.Size()}, {"sha256", installerSHA},
		{"applicationBytes", int64(len(data))}, {"applicationSHA256", applicationSHA},
		{"extractedPayloadBytes", payloadBytes}, {"cgo", true}, {"subsystem", "Windows GUI"},
		{"imports", imports},
		{"crossImage", strings.TrimSpace(crossImage)},
		{"staticCheckPassed", true}, {"nativeWindowsTested", false},
		{"externalComponents", externalComponents},
	}
	return writeReceipt(installer, receipt, installerSHA)
}
