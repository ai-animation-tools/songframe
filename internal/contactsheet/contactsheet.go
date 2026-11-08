// Package contactsheet — перенос tools/contact_sheet/contact_sheet.py замороженного оригинала
// (634fd94): техническая сводка полученного видео для быстрого просмотра.
//
// Инструмент берёт видео попытки пакета shot_workflow (--package), папки попытки media_request
// (--work-dir) или произвольный файл (--video), читает параметры потока ffprobe, одним проходом
// FFmpeg извлекает 12 равномерно распределённых кадров и рисует из них лист 4×3 с подписями
// шрифтом комплекса, сохраняет первый и последний кадры, картинки сравнения с принятыми опорами
// first/last и превью на скорости 2×. Отчёт печатается таблицей или JSON (--json). Ничего не
// оценивает и не принимает, хеши не считает, assets и реестр не меняет.
//
// Сохраняется результат оригинала: аргументы и тексты argparse, тексты и коды отказов (ValueError
// печатается, ошибки файлов, ключей и JSON скрываются общей фразой, прочие исключения — трассировка),
// отчёт и таблица побайтно, состав и размеры файлов, пиксели кадров (их декодирует тот же FFmpeg) и
// фона. Отличаются байты PNG (сжатие Go, а не zlib Pillow), сглаживание букв подписей (растеризатор
// x/image без хинтинга FreeType, см. animaticcards) и байты превью H.264 (их пишет FFmpeg, как и в
// оригинале, но x264 с автоматическим числом потоков недетерминирован между машинами).
//
// Внешние программы запускаются через mediacmd (пути менеджера компонентов, отмена задания);
// рисование — примитивами animaticcards.Picture, перенесёнными с Pillow.
package contactsheet

import (
	"context"
	"os"
	"path/filepath"
	"runtime"
	"strings"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
)

// Тексты оригинала: отказы, примечание отчёта и последняя строка таблицы.
const (
	textNoSource      = "Укажите пакет, папку попытки или файл видео."
	textNotDownloaded = "Попытка ещё не скачана: сводка делается по полученному файлу."
	textVideoMissing  = "Файл видео не найден."
	textNoVideoStream = "В файле нет видеопотока."
	textNoFrames      = "Не удалось определить число кадров."
	textMediaFailed   = "Ошибка обработки медиа: "
	textHidden        = "Ошибка файлов или медиа; сырой вывод скрыт."
	textNote          = "Техническая сводка для просмотра; художественная оценка и принятие остаются за пользователем."
	textStatus        = "Статус: ожидает просмотра пользователем."
)

// unidentifiedImage — PIL.UnidentifiedImageError (подкласс OSError) битой опоры: pycompat не знает
// классов Pillow, поэтому ветка except OSError проверяет его отдельно.
const unidentifiedImage = "PIL.UnidentifiedImageError"

// parser — argparse оригинала. Группа источников в оригинале обязательная (required=True), а
// pycompat.ArgParser знает только необязательную группу: разница (скобки в usage и ошибка
// «one of the arguments … is required») достраивается в parseArgs.
var parser = pycompat.ArgParser{
	Prog:        "contact_sheet.py",
	Description: "Техническая сводка полученного видео: параметры, контактный лист, границы, превью; @link README.md",
	Flags: []pycompat.Flag{
		{Name: "--package", Value: true, Help: "Папка shot_workflow: видео из попытки, опоры для сравнения"},
		{Name: "--work-dir", Value: true, Help: "Папка попытки media_request"},
		{Name: "--video", Value: true, Help: "Любой видеофайл"},
		{Name: "--out", Value: true, Help: "Папка сводки; по умолчанию preview/ рядом с пакетом или видео"},
		{Name: "--no-preview", Help: "Не делать превью 2×"},
		{Name: "--json"},
	},
	Exclusive: []string{"--package", "--work-dir", "--video"},
}

// sources — опции обязательной группы в порядке объявления.
var sources = []string{"--package", "--work-dir", "--video"}

// optionalGroup и requiredGroup — запись группы в usage: необязательная у pycompat, обязательная
// (в круглых скобках) у оригинала. Длина одинакова, поэтому перенос строк usage не меняется.
const (
	optionalGroup = "[--package PACKAGE | --work-dir WORK_DIR | --video VIDEO]"
	requiredGroup = "(--package PACKAGE | --work-dir WORK_DIR | --video VIDEO)"
)

// parseArgs — parse_args оригинала: результат либо готовое завершение (справка, код 2).
func parseArgs(args []string) (pycompat.Args, *pytool.Output) {
	parsed, exit := pytool.Args(parser, args)
	required := func() *pytool.Output {
		usage := strings.Replace(parser.Usage(), optionalGroup, requiredGroup, 1)
		message := usage + parser.Prog + ": error: one of the arguments " + strings.Join(sources, " ") + " is required\n"
		return &pytool.Output{Code: 2, Stderr: pycompat.TextMode(message)}
	}
	if exit != nil {
		// Обязательную группу argparse проверяет в конце parse_known_args, раньше лишних аргументов.
		if exit.Code == 2 && strings.Contains(exit.Stderr, ": error: unrecognized arguments: ") && !namesSource(args) {
			return pycompat.Args{}, required()
		}
		exit.Stdout = strings.Replace(exit.Stdout, optionalGroup, requiredGroup, 1)
		exit.Stderr = strings.Replace(exit.Stderr, optionalGroup, requiredGroup, 1)
		return pycompat.Args{}, exit
	}
	for _, name := range sources {
		if _, ok := parsed.Values[name]; ok {
			return parsed, nil
		}
	}
	return pycompat.Args{}, required()
}

// namesSource — встречается ли среди аргументов (до «--») опция группы источников: полное имя,
// «имя=значение» или однозначный префикс длинной опции, как _parse_optional argparse. Нужна только
// для порядка ошибок: когда разбор отказал лишними аргументами, источник мог быть задан.
func namesSource(args []string) bool {
	options := []string{"--help", "--package", "--work-dir", "--video", "--out", "--no-preview", "--json"}
	for _, arg := range args {
		if arg == "--" {
			return false
		}
		if !strings.HasPrefix(arg, "--") {
			continue
		}
		name, _, _ := strings.Cut(arg, "=")
		matches := []string{}
		for _, option := range options {
			if option == name {
				matches = []string{option}
				break
			}
			if strings.HasPrefix(option, name) {
				matches = append(matches, option)
			}
		}
		if len(matches) == 1 {
			for _, source := range sources {
				if matches[0] == source {
					return true
				}
			}
		}
	}
	return false
}

// Run — main() инструмента на разрешённом корне проекта root. Контекст отменяет запущенные
// FFmpeg/ffprobe (остановка задания). Результат — код, stdout и stderr процесса оригинала.
func Run(ctx context.Context, root string, args []string) pytool.Output {
	parsed, exit := parseArgs(args)
	if exit != nil {
		return *exit
	}
	var printer pytool.Printer
	err := run(ctx, root, parsed, &printer)
	switch {
	case err == nil:
		return printer.Exit(0)
	case pycompat.Is(err, pycompat.ValueError) && !pycompat.Is(err, pycompat.JSONDecodeError):
		return printer.Fail(err.Error())
	case pycompat.IsAny(err, pycompat.ValueError, pycompat.OSError, pycompat.KeyError, unidentifiedImage):
		return printer.Fail(textHidden)
	}
	return printer.Crash(err)
}

// value — значение опции или nil, если её нет.
func value(parsed pycompat.Args, name string) *string {
	values, ok := parsed.Values[name]
	if !ok || len(values) == 0 {
		return nil
	}
	return &values[len(values)-1]
}

// run — тело try оригинала: источник, папка сводки, сводка и печать отчёта.
func run(ctx context.Context, root string, parsed pycompat.Args, printer *pytool.Printer) error {
	video, base, keyframes, err := resolve(root, value(parsed, "--package"), value(parsed, "--work-dir"), value(parsed, "--video"))
	if err != nil {
		return err
	}
	out := pycompat.JoinPath(base, "preview")
	if custom := value(parsed, "--out"); custom != nil && *custom != "" {
		// Path(args.out): относительная папка считается от текущей папки процесса и печатается как есть.
		out = pycompat.JoinPath(*custom)
	}
	report, err := summarize(ctx, video, out, keyframes, !parsed.Bools["--no-preview"])
	if err != nil {
		return err
	}
	if parsed.Bools["--json"] {
		text, err := pytool.JSON(report.dict())
		if err != nil {
			return err
		}
		return printer.Print(text)
	}
	return printer.Print(report.table())
}

// keyframe — принятая опора пакета: исходная запись workflow.json и путь файла (package / path).
type keyframe struct {
	record *pycompat.Dict
	file   string
}

// resolve — resolve(package, work_dir, video, root): файл видео, папка по умолчанию для сводки
// (пакет, папка попытки или папка видео) и принятые опоры с путём. Пакет и папка попытки
// относительно корня проекта, --video — относительно текущей папки процесса, как Path.resolve().
func resolve(root string, packageDir, workDir, video *string) (string, string, []keyframe, error) {
	root = pycompat.ResolvePath(root)
	var keyframes []keyframe
	base := ""
	if packageDir != nil {
		folder := pycompat.ResolvePath(underRoot(root, *packageDir))
		workflow, err := pycompat.LoadJSONFile(pycompat.JoinPath(folder, "workflow.json"))
		if err != nil {
			return "", "", nil, err
		}
		requestDir, err := pycompat.DictGet(workflow, "request_dir", "request")
		if err != nil {
			return "", "", nil, err
		}
		request, err := joinPath(folder, requestDir)
		if err != nil {
			return "", "", nil, err
		}
		workDir = &request
		listed, err := pycompat.DictGet(workflow, "keyframes", []any{})
		if err != nil {
			return "", "", nil, err
		}
		items, err := pycompat.Iter(listed)
		if err != nil {
			return "", "", nil, err
		}
		approved := []*pycompat.Dict{}
		for _, item := range items {
			flag, err := pycompat.DictGet(item, "approved", nil)
			if err != nil {
				return "", "", nil, err
			}
			if !pycompat.Truthy(flag) {
				continue
			}
			path, err := pycompat.DictGet(item, "path", nil)
			if err != nil {
				return "", "", nil, err
			}
			if pycompat.Truthy(path) {
				approved = append(approved, item.(*pycompat.Dict))
			}
		}
		for _, record := range approved {
			file, err := joinPath(folder, record.Value("path"))
			if err != nil {
				return "", "", nil, err
			}
			keyframes = append(keyframes, keyframe{record: record, file: file})
		}
		base = folder
	}
	var path string
	if video == nil {
		if workDir == nil {
			return "", "", nil, pycompat.New(pycompat.ValueError, textNoSource)
		}
		folder := pycompat.ResolvePath(underRoot(root, *workDir))
		attempt, err := pycompat.LoadJSONFile(pycompat.JoinPath(folder, "attempt.json"))
		if err != nil {
			return "", "", nil, err
		}
		status, err := pycompat.DictGet(attempt, "status", nil)
		if err != nil {
			return "", "", nil, err
		}
		downloaded := pycompat.Equal(status, "downloaded")
		var downloads any
		if downloaded {
			if downloads, err = pycompat.DictGet(attempt, "downloads", nil); err != nil {
				return "", "", nil, err
			}
		}
		if !downloaded || !pycompat.Truthy(downloads) {
			return "", "", nil, pycompat.New(pycompat.ValueError, textNotDownloaded)
		}
		first, err := pycompat.GetItem(downloads, pycompat.NewInt(0))
		if err != nil {
			return "", "", nil, err
		}
		name, err := pycompat.Item(first, "path")
		if err != nil {
			return "", "", nil, err
		}
		if path, err = joinPath(folder, name); err != nil {
			return "", "", nil, err
		}
		if base == "" {
			base = folder
		}
	} else {
		path = pycompat.ResolvePath(*video)
		base = filepath.Dir(path)
	}
	if !pycompat.IsFile(path) {
		return "", "", nil, pycompat.New(pycompat.ValueError, textVideoMissing)
	}
	return path, base, keyframes, nil
}

// underRoot — `path if path.is_absolute() else root / path`.
func underRoot(root, path string) string {
	if filepath.IsAbs(path) {
		return pycompat.JoinPath(path)
	}
	return pycompat.JoinPath(root, path)
}

// joinPath — Path(base) / part для значения из JSON: нестроковая часть — TypeError деления пути.
func joinPath(base string, part any) (string, error) {
	text, ok := part.(string)
	if !ok {
		name := "PosixPath"
		if runtime.GOOS == "windows" {
			name = "WindowsPath"
		}
		return "", pycompat.Raise(pycompat.TypeError, "unsupported operand type(s) for /: '%s' and '%s'", name, pycompat.TypeName(part))
	}
	return pycompat.JoinPath(base, text), nil
}

// writeFile — запись файла результата с правами по умолчанию (Pillow и open() Python: 0o666 и umask).
func writeFile(path string, data []byte) error {
	if err := os.WriteFile(path, data, 0o666); err != nil {
		return pycompat.OSErrorFrom(err, path)
	}
	return nil
}
