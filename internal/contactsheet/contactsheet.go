// Package contactsheet собирает техническую сводку полученного видео для быстрого просмотра
// (инструмент contact_sheet).
//
// Инструмент берёт видео попытки пакета shot_workflow (--package), папки попытки media_request
// (--work-dir) или произвольный файл (--video), читает параметры потока ffprobe, одним проходом
// FFmpeg извлекает 12 равномерно распределённых кадров и рисует из них лист 4×3 с подписями
// шрифтом комплекса, сохраняет первый и последний кадры, картинки сравнения с принятыми опорами
// first/last и превью на скорости 2×. Отчёт печатается таблицей или JSON (--json). Ничего не
// оценивает и не принимает, хеши не считает, assets и реестр не меняет.
//
// Эталон testdata/golden/contact-sheet фиксирует аргументы и тексты разбора аргументов, тексты и коды отказов
// (ValueError печатается, ошибки файлов, ключей и JSON скрываются общей фразой, прочие исключения
// toolrt — необработанная ошибка), отчёт и таблицу побайтно, состав и размеры файлов, пиксели кадров (их декодирует
// FFmpeg) и фона. Байты PNG, сглаживание букв подписей (растеризатор x/image без хинтинга FreeType,
// см. animaticcards) и байты превью H.264 эталон не фиксирует: x264 с автоматическим числом потоков
// недетерминирован между машинами.
//
// Внешние программы запускаются через mediacmd (пути менеджера компонентов, отмена задания);
// рисование — примитивами animaticcards.Picture (те же правила пикселей, что у карточек аниматика).
package contactsheet

import (
	"context"
	"os"
	"path/filepath"
	"strings"

	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// Тексты отказов, примечание отчёта и последняя строка таблицы; зафиксированы эталоном.
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

// unidentifiedImage — вид исключения нераспознанного изображения опоры (animaticcards). Он относится
// к ошибкам файлов, но не входит в иерархию OSError toolrt, поэтому run перехватывает его отдельно.
const unidentifiedImage = "UnidentifiedImageError"

// parser — аргументы инструмента. Группа источников обязательная (одна из опций должна быть задана), а
// toolrt.ArgParser знает только необязательную группу: разница (скобки в usage и ошибка
// «нужен один из аргументов: …») достраивается в parseArgs.
var parser = toolrt.ArgParser{
	Prog:        "contact_sheet",
	Description: "Техническая сводка полученного видео: параметры, контактный лист, границы, превью; @link README.md",
	Flags: []toolrt.Flag{
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

// optionalGroup и requiredGroup — запись группы в usage: необязательная у toolrt, обязательная
// (в круглых скобках) у этого инструмента. Длина одинакова, поэтому перенос строк usage не меняется.
const (
	optionalGroup = "[--package PACKAGE | --work-dir WORK_DIR | --video VIDEO]"
	requiredGroup = "(--package PACKAGE | --work-dir WORK_DIR | --video VIDEO)"
)

// parseArgs — разбор аргументов: результат либо готовое завершение (справка, код 2).
func parseArgs(args []string) (toolrt.Args, *toolcli.Output) {
	parsed, exit := toolcli.Args(parser, args)
	required := func() *toolcli.Output {
		usage := strings.Replace(parser.Usage(), optionalGroup, requiredGroup, 1)
		message := usage + parser.Prog + ": ошибка: нужен один из аргументов: " + strings.Join(sources, " ") + "\n"
		return &toolcli.Output{Code: 2, Stderr: toolrt.TextMode(message)}
	}
	if exit != nil {
		// Обязательная группа проверяется в конце разбора, но раньше отказа лишними аргументами.
		if exit.Code == 2 && strings.Contains(exit.Stderr, ": ошибка: неизвестные аргументы: ") && !namesSource(args) {
			return toolrt.Args{}, required()
		}
		exit.Stdout = strings.Replace(exit.Stdout, optionalGroup, requiredGroup, 1)
		exit.Stderr = strings.Replace(exit.Stderr, optionalGroup, requiredGroup, 1)
		return toolrt.Args{}, exit
	}
	for _, name := range sources {
		if _, ok := parsed.Values[name]; ok {
			return parsed, nil
		}
	}
	return toolrt.Args{}, required()
}

// namesSource — встречается ли среди аргументов (до «--») опция группы источников: полное имя,
// «имя=значение» или однозначный префикс длинной опции, как при разборе опций. Нужна только
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

// Run — инструмент contact_sheet на разрешённом корне проекта root. Контекст отменяет запущенные
// FFmpeg/ffprobe (остановка задания). Результат — код, stdout и stderr процесса инструмента.
func Run(ctx context.Context, root string, args []string) toolcli.Output {
	parsed, exit := parseArgs(args)
	if exit != nil {
		return *exit
	}
	var printer toolcli.Printer
	err := run(ctx, root, parsed, &printer)
	switch {
	case err == nil:
		return printer.Exit(0)
	case toolrt.Is(err, toolrt.ValueError) && !toolrt.Is(err, toolrt.JSONDecodeError):
		return printer.Fail(err.Error())
	case toolrt.IsAny(err, toolrt.ValueError, toolrt.OSError, toolrt.KeyError, unidentifiedImage):
		return printer.Fail(textHidden)
	}
	return printer.Crash(err)
}

// value — значение опции или nil, если её нет.
func value(parsed toolrt.Args, name string) *string {
	values, ok := parsed.Values[name]
	if !ok || len(values) == 0 {
		return nil
	}
	return &values[len(values)-1]
}

// run — работа инструмента под перехватом ожидаемых исключений: источник, папка сводки, сводка и
// печать отчёта.
func run(ctx context.Context, root string, parsed toolrt.Args, printer *toolcli.Printer) error {
	video, base, keyframes, err := resolve(root, value(parsed, "--package"), value(parsed, "--work-dir"), value(parsed, "--video"))
	if err != nil {
		return err
	}
	out := toolrt.JoinPath(base, "preview")
	if custom := value(parsed, "--out"); custom != nil && *custom != "" {
		// Относительная папка --out считается от текущей папки процесса и печатается как есть.
		out = toolrt.JoinPath(*custom)
	}
	report, err := summarize(ctx, video, out, keyframes, !parsed.Bools["--no-preview"])
	if err != nil {
		return err
	}
	if parsed.Bools["--json"] {
		text, err := toolcli.JSON(report.dict())
		if err != nil {
			return err
		}
		return printer.Print(text)
	}
	return printer.Print(report.table())
}

// keyframe — принятая опора пакета: исходная запись workflow.json и путь файла (package / path).
type keyframe struct {
	record *toolrt.Dict
	file   string
}

// resolve — файл видео, папка по умолчанию для сводки
// (пакет, папка попытки или папка видео) и принятые опоры с путём. Пакет и папка попытки
// относительно корня проекта, --video — относительно текущей папки процесса.
func resolve(root string, packageDir, workDir, video *string) (string, string, []keyframe, error) {
	root = toolrt.ResolvePath(root)
	var keyframes []keyframe
	base := ""
	if packageDir != nil {
		folder := toolrt.ResolvePath(underRoot(root, *packageDir))
		workflow, err := toolrt.LoadJSONFile(toolrt.JoinPath(folder, "workflow.json"))
		if err != nil {
			return "", "", nil, err
		}
		requestDir, err := toolrt.DictGet(workflow, "request_dir", "request")
		if err != nil {
			return "", "", nil, err
		}
		request, err := joinPath(folder, requestDir)
		if err != nil {
			return "", "", nil, err
		}
		workDir = &request
		listed, err := toolrt.DictGet(workflow, "keyframes", []any{})
		if err != nil {
			return "", "", nil, err
		}
		items, err := toolrt.Iter(listed)
		if err != nil {
			return "", "", nil, err
		}
		approved := []*toolrt.Dict{}
		for _, item := range items {
			flag, err := toolrt.DictGet(item, "approved", nil)
			if err != nil {
				return "", "", nil, err
			}
			if !toolrt.Truthy(flag) {
				continue
			}
			path, err := toolrt.DictGet(item, "path", nil)
			if err != nil {
				return "", "", nil, err
			}
			if toolrt.Truthy(path) {
				approved = append(approved, item.(*toolrt.Dict))
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
			return "", "", nil, toolrt.New(toolrt.ValueError, textNoSource)
		}
		folder := toolrt.ResolvePath(underRoot(root, *workDir))
		attempt, err := toolrt.LoadJSONFile(toolrt.JoinPath(folder, "attempt.json"))
		if err != nil {
			return "", "", nil, err
		}
		status, err := toolrt.DictGet(attempt, "status", nil)
		if err != nil {
			return "", "", nil, err
		}
		downloaded := toolrt.Equal(status, "downloaded")
		var downloads any
		if downloaded {
			if downloads, err = toolrt.DictGet(attempt, "downloads", nil); err != nil {
				return "", "", nil, err
			}
		}
		if !downloaded || !toolrt.Truthy(downloads) {
			return "", "", nil, toolrt.New(toolrt.ValueError, textNotDownloaded)
		}
		first, err := toolrt.GetItem(downloads, toolrt.NewInt(0))
		if err != nil {
			return "", "", nil, err
		}
		name, err := toolrt.Item(first, "path")
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
		path = toolrt.ResolvePath(*video)
		base = filepath.Dir(path)
	}
	if !toolrt.IsFile(path) {
		return "", "", nil, toolrt.New(toolrt.ValueError, textVideoMissing)
	}
	return path, base, keyframes, nil
}

// underRoot — абсолютный path как есть, относительный — от корня root.
func underRoot(root, path string) string {
	if filepath.IsAbs(path) {
		return toolrt.JoinPath(path)
	}
	return toolrt.JoinPath(root, path)
}

// joinPath — base/part для значения из JSON: нестроковая часть — TypeError «путь и <вид>».
func joinPath(base string, part any) (string, error) {
	text, ok := part.(string)
	if !ok {
		return "", toolrt.Raise(toolrt.TypeError, "операция «/» неприменима: путь и %s", toolrt.TypeName(part))
	}
	return toolrt.JoinPath(base, text), nil
}

// writeFile — запись файла результата с правами по умолчанию (0o666 с учётом umask).
func writeFile(path string, data []byte) error {
	if err := os.WriteFile(path, data, 0o666); err != nil {
		return toolrt.OSErrorFrom(err, path)
	}
	return nil
}
