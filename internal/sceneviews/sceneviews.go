// Package sceneviews обновляет и проверяет производные представления единого реестра сцен
// (инструмент update_scene_views): документы internal/projectviews, PNG-карточки аниматика
// plan/animatic/cards/<план>.png (и .last.png последней опоры) и их квитанцию
// plan/animatic/cards/manifest.json.
//
// Обычный режим перезаписывает устаревшие представления и удаляет лишние PNG папки карточек,
// режим --check только перечисляет устаревшие и ничего не пишет. Тексты вывода, коды
// завершения, порядок списка «Устарели представления» (карточки, лишние PNG, документы),
// MissingInputError и записанные текстовые файлы зафиксированы эталоном testdata/golden/scene-views.
// Запись идёт через шлюз projectfs.CheckWrite и атомарно (projectfs.WriteFile); права
// существующего файла сохраняются, новый файл получает 0666 с учётом umask.
//
// Свежесть карточек. PNG internal/animaticcards совпадают с карточками эталонов по раскладке, но
// не по байтам, поэтому перерисовка и сравнение SHA-256 объявили бы устаревшими все карточки,
// нарисованные другим растеризатором. Карточка считается актуальной без перерисовки, если её
// подтверждает существующая квитанция manifest.json:
// квитанция — объект; её registry_sha256 равен текущему отпечатку текста реестра;
// project_inputs совпадает с проектом; reference_hashes равен вновь вычисленному словарю; запись
// cards[план] есть, её path ожидаемый; у карточки опор keyframes равен вновь найденному списку
// принятых опор (с SHA-256), у текстовой ключа keyframes нет; файл на диске имеет SHA-256 записи;
// наличие last совпадает с ожидаемым (опор не меньше двух), его path ожидаемый и SHA-256 файла
// совпадает. Тогда в квитанцию идёт запись с прежним SHA-256, а файл не перерисовывается и не
// переписывается; иначе карточка перерисовывается. Любая непригодная квитанция — просто перерисовка.
// Поэтому на актуальном проекте вывод и файлы не меняются («Представления актуальны.»,
// «Обновлено представлений: 0.»), а после правки реестра (другой registry_sha256) перерисовываются
// и перечисляются все карточки, а не только те, чьи пиксели изменились.
package sceneviews

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"syscall"

	"songframe/internal/projectfs"
	"songframe/internal/projectviews"
	"songframe/internal/toolcli"
	"songframe/internal/toolrt"
)

// Parser — разбор аргументов toolrt.ArgParser: единственный флаг --check.
var Parser = toolrt.ArgParser{
	Prog:        "update_scene_views",
	Description: "Обновляет производные представления единого реестра; @link README.md",
	Flags: []toolrt.Flag{
		{Name: "--check"},
	},
}

// Тексты вывода; меняются только вместе с эталоном testdata/golden/scene-views.
const (
	textActual    = "Представления актуальны."
	cardsDir      = "plan/animatic/cards"
	cardsManifest = cardsDir + "/manifest.json"
)

// requiredInputs — обязательные источники require_inputs в порядке проверки.
var requiredInputs = []string{"plan/scenes.json", "plan/project.json", "plan/production-status.json", "plan/audio/timing.json"}

// MissingInputError — отсутствующий обязательный источник —
// ожидаемое состояние проекта (кратко в stderr, код 1), отдельное от ошибок программы.
type MissingInputError struct{ Message string }

func (e *MissingInputError) Error() string { return e.Message }

// requireInputs — обязательные файлы должны быть в рабочем дереве.
func requireInputs(sources *projectviews.Sources) error {
	for _, name := range requiredInputs {
		if !sources.Has(name) {
			message := "Нет обязательного файла: " + name + "."
			if name == "plan/scenes.json" {
				message += " Сначала создайте сценарий."
			}
			return &MissingInputError{Message: message}
		}
	}
	return nil
}

// Run — запуск инструмента на разрешённом корне проекта.
func Run(root string, args []string) toolcli.Output {
	parsed, exit := toolcli.Args(Parser, args)
	if exit != nil {
		return *exit
	}
	printer := &toolcli.Printer{}
	check := parsed.Bools["--check"]
	changed, err := Update(root, check)
	if err != nil {
		var missing *MissingInputError
		if asMissing(err, &missing) {
			return printer.Fail(missing.Message)
		}
		return printer.Crash(err)
	}
	if check && len(changed) > 0 {
		return printer.Fail("Устарели представления: " + strings.Join(changed, ", "))
	}
	message := textActual
	if !check {
		message = "Обновлено представлений: " + toolrt.NewInt(int64(len(changed))).String() + "."
	}
	if err := printer.Print(message); err != nil {
		return printer.Crash(err)
	}
	return printer.Exit(0)
}

// asMissing — errors.As для MissingInputError без лишнего импорта в Run.
func asMissing(err error, target **MissingInputError) bool {
	missing, ok := err.(*MissingInputError)
	if ok {
		*target = missing
	}
	return ok
}

// expectedFile — ожидаемый файл папки карточек: путь от корня, SHA-256 и байты, если карточка
// перерисована (nil — подтверждена квитанцией и на диске уже нужные байты).
type expectedFile struct {
	path   string
	digest string
	data   []byte
}

// Update — обновляет (check=false) или проверяет производные представления проекта
// root и возвращает список устаревших в порядке вывода: карточки и их .last.png, лишние PNG
// папки карточек, документы (projectviews.Documents) и квитанция карточек. Отсутствующий
// обязательный источник — *MissingInputError; прочие ошибки — исключения toolrt (необработанная
// ошибка у CLI) или отказ шлюза записи. Вызывать можно из другого Go-кода без CLI.
func Update(root string, check bool) ([]string, error) {
	sources := projectviews.NewSources(root)
	if err := requireInputs(sources); err != nil {
		return nil, err
	}
	prepared, err := projectviews.Prepare(sources)
	if err != nil {
		return nil, err
	}
	documents, err := projectviews.Documents(sources, prepared)
	if err != nil {
		return nil, err
	}
	cards, files, err := expectedCards(sources, prepared)
	if err != nil {
		return nil, err
	}
	manifest, err := cardsReceipt(sources, prepared, cards)
	if err != nil {
		return nil, err
	}
	documents = append(documents, projectviews.Document{Path: cardsManifest, Text: manifest})

	writer := &writer{root: root, check: check}
	differences := []string{}
	expected := map[string]bool{}
	for _, file := range files {
		expected[file.path] = true
		target := toolrt.JoinPath(root, file.path)
		same := false
		if toolrt.IsFile(target) {
			digest, err := projectviews.FileSHA(target)
			if err != nil {
				return nil, err
			}
			same = digest == file.digest
		}
		if same {
			continue
		}
		differences = append(differences, file.path)
		if err := writer.write(target, file.data); err != nil {
			return nil, err
		}
	}
	// Папка карточек производная: PNG принятого плана или ушедшей опоры удаляется тем же запуском.
	stale := toolrt.Glob(toolrt.JoinPath(root, cardsDir), "*.png")
	toolrt.SortPaths(stale)
	for _, path := range stale {
		name := cardsDir + "/" + toolrt.PathName(path)
		if expected[name] {
			continue
		}
		differences = append(differences, name)
		if err := writer.remove(path); err != nil {
			return nil, err
		}
	}
	for _, document := range documents {
		path := toolrt.JoinPath(root, document.Path)
		if toolrt.Exists(path) {
			current, err := toolrt.ReadText(path)
			if err != nil {
				return nil, err
			}
			if current == document.Text {
				continue
			}
		}
		differences = append(differences, document.Path)
		if check {
			continue
		}
		// Текстовый режим ОС и UTF-8 (одиночный суррогат — UnicodeEncodeError).
		data, err := toolrt.EncodeUTF8(toolrt.TextMode(document.Text))
		if err != nil {
			return nil, err
		}
		if err := writer.write(path, data); err != nil {
			return nil, err
		}
	}
	return differences, nil
}

// writer — запись представлений: в режиме проверки ничего не делает; перед первой записью
// проверяет шлюз projectfs.CheckWrite (запись поверх незавершённой многофайловой операции
// запрещена), поэтому актуальный проект шлюз не трогает.
type writer struct {
	root    string
	check   bool
	checked bool
}

// gate — однократная проверка шлюза записи.
func (w *writer) gate() error {
	if w.checked {
		return nil
	}
	if err := projectfs.CheckWrite(w.root); err != nil {
		return err
	}
	w.checked = true
	return nil
}

// write — атомарная запись data в path: родительские каталоги создаются, права
// существующего файла сохраняются, новый получает 0666 с учётом umask.
func (w *writer) write(path string, data []byte) error {
	if w.check {
		return nil
	}
	if err := w.gate(); err != nil {
		return err
	}
	perm := os.FileMode(0o666)
	info, err := os.Stat(path)
	existing := err == nil
	if existing {
		if info.IsDir() {
			return toolrt.OSErrorFrom(syscall.EISDIR, path)
		}
		perm = info.Mode().Perm()
	}
	if err := projectfs.WriteFile(path, data, perm); err != nil {
		return err
	}
	if existing {
		// WriteFile создаёт временный файл с правами под umask; прежние права возвращаются явно.
		if err := os.Chmod(path, perm); err != nil {
			return toolrt.OSErrorFrom(err, path)
		}
	}
	return nil
}

// remove — удаление устаревшего файла: каталог с именем *.png — IsADirectoryError.
func (w *writer) remove(path string) error {
	if w.check {
		return nil
	}
	if err := w.gate(); err != nil {
		return err
	}
	if toolrt.IsDir(path) {
		return toolrt.OSErrorFrom(syscall.EISDIR, path)
	}
	if err := os.Remove(path); err != nil {
		return toolrt.OSErrorFrom(err, path)
	}
	return nil
}

// digestBytes — SHA-256 байтов в hex.
func digestBytes(data []byte) string {
	sum := sha256.Sum256(data)
	return hex.EncodeToString(sum[:])
}

// cardPath — путь карточки плана от корня проекта (suffix — ".png" или ".last.png").
func cardPath(sid, suffix string) string { return cardsDir + "/" + sid + suffix }
