package spend

import (
	"errors"
	"path/filepath"
	"slices"
	"strings"

	"songframe/internal/projectfs"
)

// Ref — запись расхода, которую правит пользователь: её поля-идентификаторы из EntryView.
type Ref struct {
	Shot          string  `json:"shot"`
	Attempt       string  `json:"attempt"`
	Kind          string  `json:"kind"`
	Provider      string  `json:"provider"`
	RequestSHA256 string  `json:"requestSha256"`
	GenerationID  *string `json:"generationId"`
	Frame         string  `json:"frame"`
	FileSHA256    string  `json:"fileSha256"`
}

// entry — запись с идентификаторами ссылки для сравнения same.
func (ref Ref) entry() Entry {
	return Entry{Shot: ref.Shot, Attempt: ref.Attempt, Kind: ref.Kind, Provider: ref.Provider, RequestSHA256: ref.RequestSHA256, GenerationID: ref.GenerationID,
		Frame: ref.Frame, FileSHA256: ref.FileSHA256}
}

// Тексты отказов правки стоимости.
const (
	textEntryMissing    = "Запись расхода не найдена: обновите страницу."
	textServiceReported = "Списание сообщил сервис: его сумма не правится."
	textAmountInvalid   = "Стоимость — целое число не меньше 0."
	textUnitInvalid     = "Единица стоимости — кредиты, ₽ или $."
	textAcceptedPriced  = "У принятого видео плана уже есть запись расхода: правьте её."
)

// Units — единицы стоимости, которые указывает пользователь (как у загрузки ручной генерации).
var Units = []string{"credits", "RUB", "USD"}

// checkAmount — сумма пользователя: nil (снять) или целое не меньше 0 в одной из Units.
func checkAmount(amount *float64, unit string) error {
	if amount == nil {
		return nil
	}
	if *amount < 0 || *amount != float64(int64(*amount)) {
		return errors.New(textAmountInvalid)
	}
	if !slices.Contains(Units, unit) {
		return errors.New(textUnitInvalid)
	}
	return nil
}

// SetAmount — пользователь указывает или исправляет стоимость записи ref; amount nil снимает её.
// Правится только то, что сервис не сообщил: своя опора, видео вне приложения, принятый план без
// отправки, отправка без списания. Перед правкой живые запросы переносятся в журнал, правка
// пишется в него с UserAmount; файлы попытки не меняются.
func SetAmount(root string, ref Ref, amount *float64, unit string) error {
	if err := checkAmount(amount, unit); err != nil {
		return err
	}
	all, err := Entries(root)
	if err != nil {
		return err
	}
	target := ref.entry()
	index := slices.IndexFunc(all, func(entry Entry) bool { return entry.Shot == ref.Shot && entry.Kind == ref.Kind && same(entry, target) })
	if index < 0 {
		return errors.New(textEntryMissing)
	}
	found := all[index]
	if found.Status != StatusManual && found.Amount != nil && !found.UserAmount {
		return errors.New(textServiceReported)
	}
	if err := Sync(root); err != nil {
		return err
	}
	entries, err := readJournal(root)
	if err != nil {
		return err
	}
	index = slices.IndexFunc(entries, func(entry Entry) bool { return entry.Shot == ref.Shot && entry.Kind == ref.Kind && same(entry, target) })
	if index < 0 {
		return errors.New(textEntryMissing)
	}
	entry := &entries[index]
	entry.Amount, entry.Unit = nil, nil
	if amount != nil {
		value, text := *amount, unit
		entry.Amount, entry.Unit = &value, &text
	}
	if entry.Status == StatusManual {
		// Снятая стоимость материала вне приложения тоже правка: она заменяет указанную при загрузке.
		entry.UserAmount = true
	} else {
		entry.UserAmount = amount != nil
		if amount == nil {
			// Снятая сумма отправки — снова неизвестное списание в единице сервиса.
			entry.Unit = UnitOf(entry.Provider)
		}
	}
	return projectfs.WriteJSON(filepath.Join(root, filepath.FromSlash(File)), journal{SchemaVersion: 1, Entries: entries})
}

// Kit — принятый результат плана по его комплекту: что записать для плана без отправки в журнале.
type Kit struct {
	Shot          string
	Provider      string
	RequestSHA256 string
	GenerationID  *string
}

// AddAccepted — цена принятого плана, у которого в журнале нет записи принятого видео (комплект
// принят до появления журнала или вне приложения). Запись ручная, папка — сам комплект
// (KitPrefix+Mxx), а SHA запроса и номер генерации берутся из снимка комплекта: так сводка
// узнаёт в ней принятое видео.
func AddAccepted(root string, kit Kit, amount float64, unit string) error {
	if err := checkAmount(&amount, unit); err != nil {
		return err
	}
	if strings.TrimSpace(kit.RequestSHA256) == "" {
		return errors.New(textEntryMissing)
	}
	if err := Sync(root); err != nil {
		return err
	}
	entries, err := readJournal(root)
	if err != nil {
		return err
	}
	accepted := &Accepted{GenerationID: kit.GenerationID, RequestSHA256: kit.RequestSHA256}
	if slices.ContainsFunc(entries, func(entry Entry) bool {
		return entry.Shot == kit.Shot && entry.Kind == "video" && isAccepted(entry, accepted)
	}) {
		return errors.New(textAcceptedPriced)
	}
	value, text := amount, unit
	entries = append(entries, Entry{
		Shot: kit.Shot, Attempt: KitPrefix + kit.Shot, Kind: "video", Provider: kit.Provider, RequestSHA256: kit.RequestSHA256,
		GenerationID: kit.GenerationID, Status: StatusManual, Amount: &value, Unit: &text,
	})
	return projectfs.WriteJSON(filepath.Join(root, filepath.FromSlash(File)), journal{SchemaVersion: 1, Entries: entries})
}
