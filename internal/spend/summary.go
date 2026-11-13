package spend

import "strings"

// Total — сумма известного расхода в одной единице одного источника. Кредиты разных сервисов —
// разные единицы, поэтому сумма отдельна для каждого провайдера (Provider) и для ручных генераций
// (Provider null, единицы credits, RUB, USD). Unit null — единица провайдера неизвестна.
type Total struct {
	Provider *string `json:"provider"`
	Unit     *string `json:"unit"`
	Amount   float64 `json:"amount"`
}

// Accepted — принятый результат плана: какая отправка дала видео и сколько секунд материала.
type Accepted struct {
	// GenerationID — номер генерации принятого видео; nil у ручной генерации.
	GenerationID *string
	// RequestSHA256 — SHA-256 запроса принятой попытки.
	RequestSHA256 string
	// Seconds — длина принятого материала (кадры комплекта / fps).
	Seconds float64
}

// EntryView — запись расхода плана для окна «Расход Mxx»: что это, сколько стоило и можно ли
// указать стоимость. Ref возвращается в SetAmount.
type EntryView struct {
	Ref Ref `json:"ref"`
	// Kind — video или image.
	Kind string `json:"kind"`
	// Provider — id сервиса отправки; null у материала, созданного вне приложения.
	Provider *string `json:"provider"`
	// Status — sent, unknown или manual.
	Status string   `json:"status"`
	Amount *float64 `json:"amount"`
	Unit   *string  `json:"unit"`
	// Frame — опора своей опоры; пусто у видео и отправок изображений.
	Frame string `json:"frame"`
	// Accepted — видео стало принятым результатом плана.
	Accepted bool `json:"accepted"`
	// Kit — запись цены принятого плана без отправки (AddAccepted).
	Kit bool `json:"kit"`
	// Removed — папки попытки уже нет: запись известна только по журналу.
	Removed bool `json:"removed"`
	// UserAmount — сумму отправки указал пользователь.
	UserAmount bool `json:"userAmount"`
	// Editable — стоимость можно указать или исправить: всё, что не сообщил сервис.
	Editable bool `json:"editable"`
}

// Summary — расход плана в исходных единицах. Неизвестный расход не входит в суммы, а считается
// отдельно (Unknown, Unpriced): тогда суммы и стоимость секунды — нижняя граница.
type Summary struct {
	// Attempts — попытки (папки) с хотя бы одной отправкой.
	Attempts int `json:"attempts"`
	// Removed — из них попытки, папок которых уже нет (удалены): их отправки известны только по
	// журналу. 0 у принятого плана: приёмка с очисткой убирает папки всех его попыток.
	Removed int `json:"removed"`
	// Images — отправки запросов изображений; Videos — видео, включая созданные вне приложения.
	Images int `json:"images"`
	Videos int `json:"videos"`
	// OwnImages — свои опоры (загружены файлом); в Images не входят.
	OwnImages int `json:"ownImages"`
	// Rejected — отправки видео, не ставшие принятым результатом; 0, пока план не принят: в работе
	// последний вариант ещё ждёт решения.
	Rejected int `json:"rejected"`
	// Unknown — отправки сервису с неизвестным расходом: исход неизвестен или сервис не сообщил
	// списание, а пользователь сумму не указал.
	Unknown int `json:"unknown"`
	// Unpriced — видео, созданные вне приложения, без указанной стоимости, плюс принятое видео без
	// записи (Missing). Своя опора без стоимости сюда не входит: опоры часто рисуют сами.
	Unpriced int `json:"unpriced"`
	// Missing — план принят, а записи принятого видео в журнале нет (комплект принят до журнала):
	// цену указывают через AddAccepted.
	Missing bool `json:"missing"`
	// Manual — видео, созданные вне приложения (ручная генерация, своё видео).
	Manual int `json:"manual"`
	// Totals — известный расход по единицам, в порядке первого появления.
	Totals []Total `json:"totals"`
	// AcceptedSeconds — длина принятого материала; null, пока план не принят.
	AcceptedSeconds *float64 `json:"acceptedSeconds"`
	// PerSecond — Totals на секунду принятого материала; пусто, пока план не принят.
	PerSecond []Total `json:"perSecond"`
	// Entries — записи плана по порядку журнала.
	Entries []EntryView `json:"entries"`
}

// Summarize — расход плана shot по записям entries (Entries проекта). accepted nil — план не принят.
func Summarize(entries []Entry, shot string, accepted *Accepted) Summary {
	summary := Summary{Totals: []Total{}, PerSecond: []Total{}, Entries: []EntryView{}}
	// attempts — попытка плана с отправкой или видео и есть ли у неё живая папка.
	attempts := map[string]bool{}
	acceptedFound := false
	for _, entry := range entries {
		if entry.Shot != shot {
			continue
		}
		manual := entry.Status == StatusManual
		kit := manual && strings.HasPrefix(entry.Attempt, KitPrefix)
		own := entry.Frame != ""
		view := EntryView{
			Ref: Ref{Shot: entry.Shot, Attempt: entry.Attempt, Kind: entry.Kind, Provider: entry.Provider, RequestSHA256: entry.RequestSHA256, GenerationID: entry.GenerationID,
				Frame: entry.Frame, FileSHA256: entry.FileSHA256},
			Kind: entry.Kind, Status: entry.Status, Amount: entry.Amount, Unit: entry.Unit, Frame: entry.Frame, Kit: kit,
			Removed: !entry.live && !kit, UserAmount: entry.UserAmount, Editable: manual || entry.Amount == nil || entry.UserAmount,
		}
		if !own && !kit {
			attempts[entry.Attempt] = attempts[entry.Attempt] || entry.live
		}
		switch {
		case own:
			summary.OwnImages++
		case entry.Kind == "image":
			summary.Images++
		default:
			summary.Videos++
			if accepted != nil && !acceptedFound && isAccepted(entry, accepted) {
				acceptedFound, view.Accepted = true, true
			}
		}
		var provider *string
		if manual {
			if !own {
				summary.Manual++
			}
		} else {
			name := entry.Provider
			provider, view.Provider = &name, &name
		}
		switch {
		case entry.Amount != nil:
			add(&summary.Totals, provider, entry.Unit, *entry.Amount)
		case own:
		case manual:
			summary.Unpriced++
		default:
			summary.Unknown++
		}
		summary.Entries = append(summary.Entries, view)
	}
	summary.Attempts = len(attempts)
	if accepted == nil {
		for _, live := range attempts {
			if !live {
				summary.Removed++
			}
		}
	}
	if accepted != nil {
		summary.Rejected = summary.Videos
		if acceptedFound {
			summary.Rejected--
		} else {
			summary.Missing = true
			summary.Unpriced++
		}
	}
	if accepted != nil && accepted.Seconds > 0 {
		seconds := accepted.Seconds
		summary.AcceptedSeconds = &seconds
		for _, total := range summary.Totals {
			summary.PerSecond = append(summary.PerSecond, Total{Provider: total.Provider, Unit: total.Unit, Amount: total.Amount / seconds})
		}
	}
	return summary
}

// isAccepted — отправка дала принятое видео: тот же номер генерации, а без номера — тот же запрос.
func isAccepted(entry Entry, accepted *Accepted) bool {
	if entry.GenerationID != nil && accepted.GenerationID != nil {
		return *entry.GenerationID == *accepted.GenerationID
	}
	return entry.RequestSHA256 != "" && entry.RequestSHA256 == accepted.RequestSHA256
}

// add — прибавляет amount к сумме своего источника и единицы; разные не складываются.
func add(totals *[]Total, provider, unit *string, amount float64) {
	for index := range *totals {
		total := &(*totals)[index]
		if sameText(total.Provider, provider) && sameText(total.Unit, unit) {
			total.Amount += amount
			return
		}
	}
	*totals = append(*totals, Total{Provider: provider, Unit: unit, Amount: amount})
}

// sameText — оба значения отсутствуют или равны.
func sameText(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}

// AcceptedEntry — запись видео плана shot, ставшего принятым результатом; nil, если её нет.
func AcceptedEntry(entries []Entry, shot string, accepted *Accepted) *Entry {
	if accepted == nil {
		return nil
	}
	for index := range entries {
		if entries[index].Shot == shot && entries[index].Kind == "video" && isAccepted(entries[index], accepted) {
			return &entries[index]
		}
	}
	return nil
}
