// Package spend ведёт журнал платных отправок проекта plan/spend.json и считает расход плана.
//
// Сведения об отправке живут в attempt.json запроса внутри папки попытки (plan/batches,
// plan/awaiting), а приёмка и «Удалить попытку» эти папки удаляют. Журнал сохраняет отправки до
// удаления: Sync переносит в него текущее состояние всех живых запросов и вызывается после
// отправки, перед приёмкой с очисткой, перед удалением попытки и после «генерация не создана».
// Расход плана — журнал, дополненный живыми запросами (живое состояние новее).
//
// Одна генерация учитывается один раз: запись с номером генерации совпадает с другой по
// провайдеру и номеру, запись без номера (исход отправки неизвестен) — по SHA-256 запроса.
// Поэтому перенос попытки в очередь, повторная приёмка и найденный позже номер генерации не
// удваивают расход, а повтор по сохранённому запросу (тот же SHA, новый номер) учитывается
// отдельно. Неизвестный расход не считается нулём, разные единицы не складываются.
package spend

import (
	"encoding/json"
	"errors"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"sort"
	"strings"

	"songframe/internal/mediaadapters"
	"songframe/internal/mediaapi"
	"songframe/internal/projectfs"
)

// File — журнал отправок от корня проекта.
const File = "plan/spend.json"

// Статусы записи журнала.
const (
	// StatusSent — сервис принял запрос и вернул номер генерации.
	StatusSent = "sent"
	// StatusUnknown — отправка начата, исход неизвестен: списание возможно, номера нет.
	StatusUnknown = "unknown"
	// StatusManual — видео создано вне приложения (ручная генерация); расход — стоимость, которую
	// указал пользователь при загрузке, иначе неизвестен.
	StatusManual = "manual"
)

// Entry — одна отправка запроса изображения или видео.
type Entry struct {
	// Shot — план из request.json.
	Shot string `json:"shot"`
	// Attempt — папка попытки от корня проекта через «/» в момент последней записи.
	Attempt string `json:"attempt"`
	// Kind — image или video.
	Kind string `json:"kind"`
	// Provider — id провайдера запроса.
	Provider string `json:"provider"`
	// RequestSHA256 — SHA-256 замороженного запроса из attempt.json.
	RequestSHA256 string `json:"request_sha256"`
	// GenerationID — номер генерации у сервиса; null до него и у ручной генерации.
	GenerationID *string `json:"generation_id"`
	Status       string  `json:"status"`
	// Amount — фактический расход из ответа сервиса (credits_consumed) или стоимость ручной
	// генерации, указанная пользователем; null — неизвестен.
	Amount *float64 `json:"amount"`
	// Unit — единица расхода: currency таблицы цен провайдера или единица стоимости ручной
	// генерации (credits, RUB, USD); null — неизвестна.
	Unit *string `json:"unit"`
}

// journal — содержимое plan/spend.json.
type journal struct {
	SchemaVersion int     `json:"schema_version"`
	Entries       []Entry `json:"entries"`
}

// live — запрос в живой папке попытки: отправка (Entry) или неотправленный запрос (sent=false).
type live struct {
	entry Entry
	sent  bool
}

// same — две записи описывают одну отправку: по номеру генерации, а без номера — по SHA запроса.
func same(a, b Entry) bool {
	if a.GenerationID != nil && b.GenerationID != nil {
		return a.Provider == b.Provider && *a.GenerationID == *b.GenerationID
	}
	return a.RequestSHA256 != "" && a.RequestSHA256 == b.RequestSHA256 && (a.GenerationID == nil || b.GenerationID == nil)
}

// readJournal — записи журнала; нет файла — пусто, повреждённый файл — ошибка (не перезаписывается).
func readJournal(root string) ([]Entry, error) {
	data, err := os.ReadFile(filepath.Join(root, filepath.FromSlash(File)))
	if errors.Is(err, os.ErrNotExist) {
		return []Entry{}, nil
	}
	if err != nil {
		return nil, err
	}
	var value journal
	if err := json.Unmarshal(data, &value); err != nil || value.SchemaVersion != 1 {
		return nil, errors.New("Журнал расходов " + File + " повреждён; исправьте или удалите его.")
	}
	if value.Entries == nil {
		value.Entries = []Entry{}
	}
	return value.Entries, nil
}

// merge — журнал, обновлённый живыми запросами: отправка заменяет свою прежнюю запись, а
// неотправленный запрос (исход «генерация не создана») снимает запись без номера с тем же SHA.
func merge(entries []Entry, current []live) []Entry {
	result := slices.Clone(entries)
	for _, item := range current {
		if !item.sent {
			result = slices.DeleteFunc(result, func(entry Entry) bool {
				return entry.GenerationID == nil && entry.Status == StatusUnknown && entry.RequestSHA256 == item.entry.RequestSHA256
			})
			continue
		}
		result = slices.DeleteFunc(result, func(entry Entry) bool { return same(entry, item.entry) })
		result = append(result, item.entry)
	}
	sort.SliceStable(result, func(i, j int) bool {
		if result[i].Shot != result[j].Shot {
			return result[i].Shot < result[j].Shot
		}
		return result[i].Attempt < result[j].Attempt
	})
	return result
}

// Sync переносит в журнал текущее состояние всех живых запросов проекта. Файл пишется атомарно и
// только при изменении; новый проект без отправок файла не получает.
func Sync(root string) error {
	entries, err := readJournal(root)
	if err != nil {
		return err
	}
	current, err := scan(root)
	if err != nil {
		return err
	}
	next := merge(entries, current)
	if slices.EqualFunc(entries, next, equal) {
		return nil
	}
	return projectfs.WriteJSON(filepath.Join(root, filepath.FromSlash(File)), journal{SchemaVersion: 1, Entries: next})
}

// equal — записи журнала совпадают по всем полям.
func equal(a, b Entry) bool {
	left, _ := json.Marshal(a)
	right, _ := json.Marshal(b)
	return string(left) == string(right)
}

// Entries — расход проекта: журнал, дополненный живыми запросами. Ничего не пишет.
func Entries(root string) ([]Entry, error) {
	entries, err := readJournal(root)
	if err != nil {
		return nil, err
	}
	current, err := scan(root)
	if err != nil {
		return nil, err
	}
	return merge(entries, current), nil
}

// attemptFolder — папка попытки с кодом плана в начале имени (Mxx-…, Mxx_…, Mxx).
var attemptFolder = regexp.MustCompile(`^M\d{2}(?:\.\d+)?(?:[-_]|$)`)

// scan — запросы живых попыток: attempt.json в папке попытки или в её подпапке запроса.
// Нечитаемый запрос пропускается: его покажет проверка пакетов, а расход учтётся после исправления.
func scan(root string) ([]live, error) {
	result := []live{}
	for _, base := range []string{"plan/batches", "plan/awaiting"} {
		folders, err := os.ReadDir(filepath.Join(root, filepath.FromSlash(base)))
		if errors.Is(err, os.ErrNotExist) {
			continue
		}
		if err != nil {
			return nil, err
		}
		for _, folder := range folders {
			if !folder.IsDir() || !attemptFolder.MatchString(folder.Name()) {
				continue
			}
			attempt := base + "/" + folder.Name()
			directory := filepath.Join(root, filepath.FromSlash(attempt))
			candidates := []string{directory}
			children, err := os.ReadDir(directory)
			if err != nil {
				return nil, err
			}
			for _, child := range children {
				if child.IsDir() {
					candidates = append(candidates, filepath.Join(directory, child.Name()))
				}
			}
			for _, candidate := range candidates {
				if item, ok := readRequest(candidate, attempt); ok {
					result = append(result, item)
				}
			}
		}
	}
	return result, nil
}

// readRequest — отправка запроса в папке directory по request.json и attempt.json.
func readRequest(directory, attempt string) (live, bool) {
	var request struct {
		Shot     string `json:"shot"`
		Kind     string `json:"kind"`
		Provider string `json:"provider"`
	}
	var state struct {
		Status           string   `json:"status"`
		RequestSHA256    string   `json:"request_sha256"`
		GenerationID     *string  `json:"generation_id"`
		CreditsConsumed  *float64 `json:"credits_consumed"`
		ManualGeneration *struct {
			Cost *struct {
				Amount *float64 `json:"amount"`
				Unit   string   `json:"unit"`
			} `json:"cost"`
		} `json:"manual_generation"`
	}
	if !readFile(filepath.Join(directory, "request.json"), &request) || !readFile(filepath.Join(directory, "attempt.json"), &state) {
		return live{}, false
	}
	if request.Shot == "" || (request.Kind != "image" && request.Kind != "video") || state.RequestSHA256 == "" {
		return live{}, false
	}
	entry := Entry{
		Shot: request.Shot, Attempt: attempt, Kind: request.Kind, Provider: request.Provider,
		RequestSHA256: state.RequestSHA256, Amount: state.CreditsConsumed,
	}
	if state.GenerationID != nil && *state.GenerationID != "" {
		entry.GenerationID = state.GenerationID
	}
	manual := state.ManualGeneration != nil
	switch {
	case manual:
		entry.Status, entry.Amount = StatusManual, nil
		if cost := state.ManualGeneration.Cost; cost != nil && cost.Amount != nil && cost.Unit != "" {
			unit := cost.Unit
			entry.Amount, entry.Unit = cost.Amount, &unit
		}
	case entry.GenerationID != nil:
		entry.Status = StatusSent
	case state.Status == "submitting" || state.Status == "submission_unknown":
		entry.Status, entry.Amount = StatusUnknown, nil
	default:
		return live{entry: entry}, true
	}
	if !manual {
		entry.Unit = UnitOf(entry.Provider)
	}
	return live{entry: entry, sent: true}, true
}

// readFile — JSON-файл в value; false, если файла нет или он не читается.
func readFile(path string, value any) bool {
	data, err := os.ReadFile(path)
	return err == nil && json.Unmarshal(data, value) == nil
}

// UnitOf — единица расхода провайдера (currency его таблицы цен); nil, если таблицы нет.
func UnitOf(provider string) *string {
	adapter, ok := mediaadapters.Get(provider)
	if !ok {
		return nil
	}
	var data []byte
	if embedded, ok := adapter.(mediaapi.PricingDataer); ok {
		data = embedded.PricingData()
	} else if filer, ok := adapter.(mediaapi.PricingFiler); ok {
		path, err := filer.PricingFile()
		if err != nil {
			return nil
		}
		if data, err = os.ReadFile(path); err != nil {
			return nil
		}
	}
	var pricing struct {
		Currency string `json:"currency"`
	}
	if json.Unmarshal(data, &pricing) != nil || strings.TrimSpace(pricing.Currency) == "" {
		return nil
	}
	return &pricing.Currency
}
