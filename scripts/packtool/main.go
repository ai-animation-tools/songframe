// Packtool — инструмент сборщика поставок и проверок разработчика: лицензионные материалы,
// квитанции сборки, значки темы hicolor, политика runtime AppDir, подготовка и статическая проверка Windows-поставки,
// проверка рецептов на паре FFmpeg/ffprobe. В поставку он не входит; shell-рецепты вызывают его
// из корня репозитория через `go run ./scripts/packtool <подкоманда>`, поэтому сборщику не
// нужно ничего, кроме уже обязательного Go и перечисленных системных программ.
package main

import (
	"fmt"
	"os"
	"strings"
)

// command — подкоманда: run возвращает код выхода процесса.
type command struct {
	usage string
	run   func([]string) int
}

// withError превращает подкоманду с ошибкой в код выхода: 1 и текст ошибки в stderr.
func withError(run func([]string) error) func([]string) int {
	return func(arguments []string) int {
		if err := run(arguments); err != nil {
			fmt.Fprintln(os.Stderr, "packtool:", err)
			return 1
		}
		return 0
	}
}

// commands — все подкоманды в порядке справки.
var commands = map[string]command{
	"notices":           {"APPDIR [linux|windows|deb]", withError(noticesCommand)},
	"metadata":          {"IMAGE APPDIR LINUXDEPLOY VERSION | --deb PACKAGE TREE VERSION", withError(metadataCommand)},
	"runtime-policy":    {"prune|check APPDIR", runtimePolicyCommand},
	"windows-info":      {"VERSION NUMERIC OUT", withError(windowsInfoCommand)},
	"extract-vcruntime": {"ARCHIVE DIR", withError(extractVCRuntimeCommand)},
	"check-windows":     {"EXE INSTALLER VERSION IMAGE", withError(checkWindowsCommand)},
	"media-check":       {"BIN_DIR WORK MANIFEST", mediaCheckCommand},
	"media-sources":     {"DIR", withError(mediaSourcesCommand)},
	"media-hashes":      {"DIR", withError(mediaHashesCommand)},
	"icons":             {"SOURCE NAME SHARE", withError(iconsCommand)},
}

// commandOrder — порядок подкоманд в справке.
var commandOrder = []string{
	"notices", "metadata", "runtime-policy", "windows-info", "extract-vcruntime", "check-windows",
	"media-check", "media-sources", "media-hashes", "icons",
}

func main() {
	if len(os.Args) < 2 {
		usage()
		os.Exit(2)
	}
	selected, ok := commands[os.Args[1]]
	if !ok {
		usage()
		os.Exit(2)
	}
	os.Exit(selected.run(os.Args[2:]))
}

// usage печатает список подкоманд в stderr.
func usage() {
	var text strings.Builder
	text.WriteString("Использование: go run ./scripts/packtool ПОДКОМАНДА АРГУМЕНТЫ\n")
	for _, name := range commandOrder {
		fmt.Fprintf(&text, "  %s %s\n", name, commands[name].usage)
	}
	os.Stderr.WriteString(text.String())
}
