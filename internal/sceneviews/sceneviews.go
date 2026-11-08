// Package sceneviews — перенос tools/update_scene_views/update_scene_views.py замороженного
// оригинала (634fd94): обновление и проверка производных представлений единого реестра сцен —
// документов internal/projectviews, PNG-карточек аниматика plan/animatic/cards/<план>.png (и
// .last.png последней опоры) и их квитанции plan/animatic/cards/manifest.json.
//
// Обычный режим перезаписывает устаревшие представления и удаляет лишние PNG папки карточек,
// режим --check только перечисляет устаревшие и ничего не пишет. Тексты вывода, коды
// завершения, порядок списка «Устарели представления» (карточки, лишние PNG, документы),
// MissingInputError и записанные текстовые файлы совпадают с оригиналом. Запись идёт через шлюз
// projectfs.CheckWrite и атомарно (projectfs.WriteFile); права существующего файла сохраняются,
// новый файл получает 0666 с учётом umask, как write_text/write_bytes Python.
//
// Сознательное отличие от оригинала — свежесть карточек. Оригинал при каждом запуске заново
// рисовал все карточки во временную папку и сравнивал SHA-256 с файлами проекта. PNG Go
// (internal/animaticcards) совпадают с Pillow по раскладке, но не по байтам, поэтому так Go
// объявил бы устаревшими все карточки, нарисованные Electron. Здесь карточка считается
// актуальной без перерисовки, если её подтверждает существующая квитанция manifest.json:
// квитанция — объект; её registry_sha256 равен текущему отпечатку текста реестра;
// project_inputs совпадает с проектом; reference_hashes равен вновь вычисленному словарю; запись
// cards[план] есть, её path ожидаемый; у карточки опор keyframes равен вновь найденному списку
// принятых опор (с SHA-256), у текстовой ключа keyframes нет; файл на диске имеет SHA-256 записи;
// наличие last совпадает с ожидаемым (опор не меньше двух), его path ожидаемый и SHA-256 файла
// совпадает. Тогда в квитанцию идёт запись с прежним SHA-256, а файл не перерисовывается и не
// переписывается; иначе карточка рисуется Go. Любая непригодная квитанция — просто перерисовка.
// Поэтому на актуальном проекте вывод и файлы те же, что у оригинала («Представления актуальны.»,
// «Обновлено представлений: 0.»), а после правки реестра (другой registry_sha256) перерисовываются
// и перечисляются все карточки, а не только те, чьи пиксели изменились у Pillow.
//
// Проверка снимков Git (--staged, --ref) — инструмент разработчика оригинала, не перенесена:
// без --check остаётся отказ argparse оригинала, с --check — код 1 и пояснение.
package sceneviews

import (
	"crypto/sha256"
	"encoding/hex"
	"os"
	"strings"
	"syscall"

	"songframe-go/internal/projectfs"
	"songframe-go/internal/projectviews"
	"songframe-go/internal/pycompat"
	"songframe-go/internal/pytool"
)

// Parser — argparse оригинала (описание — docstring модуля): --check и взаимоисключающие
// --staged/--ref.
var Parser = pycompat.ArgParser{
	Prog:        "update_scene_views.py",
	Description: "Обновляет производные представления единого реестра; @link README.md",
	Flags: []pycompat.Flag{
		{Name: "--check"},
		{Name: "--staged"},
		{Name: "--ref", Value: true},
	},
	Exclusive: []string{"--staged", "--ref"},
}

// Тексты вывода (дословно из оригинала, кроме textSnapshotNotMigrated — пояснения Go-версии).
const (
	textSnapshotCheckOnly   = "Снимок Git доступен только для проверки."
	textSnapshotNotMigrated = "Проверка снимка Git — инструмент разработчика; в Go-версии SongFrame не перенесена."
	textActual              = "Представления актуальны."
	cardsDir                = "plan/animatic/cards"
	cardsManifest           = cardsDir + "/manifest.json"
)

// requiredInputs — обязательные источники require_inputs в порядке проверки.
var requiredInputs = []string{"plan/scenes.json", "plan/project.json", "plan/production-status.json", "plan/audio/timing.json"}

// MissingInputError — MissingInputError оригинала: отсутствующий обязательный источник —
// ожидаемое состояние проекта (кратко в stderr, код 1), отдельное от ошибок программы.
type MissingInputError struct{ Message string }

func (e *MissingInputError) Error() string { return e.Message }

// requireInputs — require_inputs(sources): обязательные файлы должны быть в рабочем дереве.
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

// Run — main() инструмента на разрешённом корне проекта.
func Run(root string, args []string) pytool.Output {
	parsed, exit := pytool.Args(Parser, args)
	if exit != nil {
		return *exit
	}
	printer := &pytool.Printer{}
	check := parsed.Bools["--check"]
	ref := parsed.Values["--ref"]
	if parsed.Bools["--staged"] || len(ref) > 0 && ref[0] != "" {
		if !check {
			return pytool.Output{Code: 2, Stderr: pycompat.TextMode(Parser.Usage() + Parser.Prog + ": error: " + textSnapshotCheckOnly + "\n")}
		}
		return printer.Fail(textSnapshotNotMigrated)
	}
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
		message = "Обновлено представлений: " + pycompat.NewInt(int64(len(changed))).String() + "."
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

// Update — update(check): обновляет (check=false) или проверяет производные представления проекта
// root и возвращает список устаревших в порядке оригинала: карточки и их .last.png, лишние PNG
// папки карточек, документы (projectviews.Documents) и квитанция карточек. Отсутствующий
// обязательный источник — *MissingInputError; прочие ошибки — исключения pycompat (трассировка
// у CLI) или отказ шлюза записи. Вызывать можно из другого Go-кода без CLI.
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
		target := pycompat.JoinPath(root, file.path)
		same := false
		if pycompat.IsFile(target) {
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
	stale := pycompat.Glob(pycompat.JoinPath(root, cardsDir), "*.png")
	pycompat.SortPaths(stale)
	for _, path := range stale {
		name := cardsDir + "/" + pycompat.PathName(path)
		if expected[name] {
			continue
		}
		differences = append(differences, name)
		if err := writer.remove(path); err != nil {
			return nil, err
		}
	}
	for _, document := range documents {
		path := pycompat.JoinPath(root, document.Path)
		if pycompat.Exists(path) {
			current, err := pycompat.ReadText(path)
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
		// write_text: текстовый режим ОС и UTF-8 (одиночный суррогат — UnicodeEncodeError).
		data, err := pycompat.EncodeUTF8(pycompat.TextMode(document.Text))
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

// write — path.write_bytes/write_text(data) атомарно: родительские каталоги создаются, права
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
			return pycompat.OSErrorFrom(syscall.EISDIR, path)
		}
		perm = info.Mode().Perm()
	}
	if err := projectfs.WriteFile(path, data, perm); err != nil {
		return err
	}
	if existing {
		// WriteFile создаёт временный файл с правами под umask; прежние права возвращаются явно.
		if err := os.Chmod(path, perm); err != nil {
			return pycompat.OSErrorFrom(err, path)
		}
	}
	return nil
}

// remove — stale.unlink(): каталог с именем *.png — IsADirectoryError, как у Path.unlink.
func (w *writer) remove(path string) error {
	if w.check {
		return nil
	}
	if err := w.gate(); err != nil {
		return err
	}
	if pycompat.IsDir(path) {
		return pycompat.OSErrorFrom(syscall.EISDIR, path)
	}
	if err := os.Remove(path); err != nil {
		return pycompat.OSErrorFrom(err, path)
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
