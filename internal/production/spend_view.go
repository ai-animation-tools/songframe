package production

import (
	"errors"
	"fmt"
	"path/filepath"
	"slices"

	"songframe/internal/derivedshot"
	"songframe/internal/dynvalue"
	"songframe/internal/spend"
)

// SpendFor — расход плана shot по журналу plan/spend.json и живым попыткам. Принятый результат —
// по комплекту assets/shots/Mxx: номер генерации и SHA запроса из снимка generation-request.json,
// длина материала — кадры accepted_edit на его fps. Только чтение.
func SpendFor(project, shot string) (spend.Summary, error) {
	if !acceptedShotID.MatchString(shot) {
		return spend.Summary{}, fmt.Errorf("неверный код плана: %q", shot)
	}
	entries, err := spend.Entries(project)
	if err != nil {
		return spend.Summary{}, err
	}
	return spend.Summarize(entries, shot, acceptedResult(project, shot)), nil
}

// acceptedResult — принятый результат плана для сводки расхода; nil без комплекта или его длины.
func acceptedResult(project, shot string) *spend.Accepted {
	dir := filepath.Join(project, "assets", "shots", shot)
	manifest := readJSON(filepath.Join(dir, "manifest.json"))
	edit := dynvalue.Get(manifest, "accepted_edit")
	frames, fps := dynvalue.Get(edit, "frames"), dynvalue.Get(edit, "fps")
	if !dynvalue.IsFinite(frames) || !dynvalue.IsFinite(fps) || dynvalue.ToNumber(fps) <= 0 {
		return nil
	}
	kit := kitOf(project, shot)
	return &spend.Accepted{Seconds: dynvalue.ToNumber(frames) / dynvalue.ToNumber(fps), GenerationID: kit.GenerationID, RequestSHA256: kit.RequestSHA256}
}

// kitOf — чем принятое видео плана отмечено в журнале: провайдер, номер генерации и SHA запроса
// из снимка generation-request.json комплекта. Без снимка или SHA в нём вместо SHA запроса —
// «original:» и SHA оригинала из manifest.json: так цена такого комплекта (AddAccepted) тоже
// узнаётся как принятое видео.
func kitOf(project, shot string) spend.Kit {
	dir := filepath.Join(project, "assets", "shots", shot)
	generation := dynvalue.Get(readJSON(filepath.Join(dir, "manifest.json")), "generation")
	kit := spend.Kit{Shot: shot}
	if path, err := existingAssetFile(dir, dynvalue.GetPath(generation, "request", "path")); err == nil && path != nil {
		request := readJSON(*path)
		if id, ok := dynvalue.Get(request, "generation_id").(string); ok && id != "" {
			kit.GenerationID = &id
		}
		if sha, ok := dynvalue.Get(request, "request_sha256").(string); ok {
			kit.RequestSHA256 = sha
		}
		if provider, ok := dynvalue.Get(request, "provider").(string); ok {
			kit.Provider = provider
		}
	}
	if kit.RequestSHA256 == "" {
		if sha, ok := dynvalue.GetPath(generation, "original", "sha256").(string); ok && sha != "" {
			kit.RequestSHA256 = "original:" + sha
		}
	}
	return kit
}

// SetSpendAmount — production:setSpendAmount: пользователь указывает или исправляет стоимость
// записи расхода (spend.SetAmount); amount nil снимает её.
func SetSpendAmount(project string, ref spend.Ref, amount *float64, unit string) error {
	if !acceptedShotID.MatchString(ref.Shot) {
		return fmt.Errorf("неверный код плана: %q", ref.Shot)
	}
	return spend.SetAmount(project, ref, amount, unit)
}

// PriceAccepted — production:priceAccepted: цена принятого плана, у которого в журнале нет записи
// принятого видео (spend.AddAccepted по снимку комплекта).
func PriceAccepted(project, shot string, amount float64, unit string) error {
	if !acceptedShotID.MatchString(shot) {
		return fmt.Errorf("неверный код плана: %q", shot)
	}
	if acceptedResult(project, shot) == nil {
		return errors.New(textNoAcceptedKit)
	}
	return spend.AddAccepted(project, kitOf(project, shot), amount, unit)
}

// ProjectTotal — сумма расхода клипа в одной единице одного источника и планы, из которых она
// сложилась.
type ProjectTotal struct {
	spend.Total
	Shots []string `json:"shots"`
}

// ShotSpendBadge — расход плана для бейджа в списке планов: суммы, неизвестный и неуказанный
// расход. Записей нет — план ещё ничего не стоил.
type ShotSpendBadge struct {
	Shot     string        `json:"shot"`
	Totals   []spend.Total `json:"totals"`
	Unknown  int           `json:"unknown"`
	Unpriced int           `json:"unpriced"`
	Missing  bool          `json:"missing"`
	Entries  int           `json:"entries"`
}

// ProjectSpend — расход клипа по всем планам реестра (без производных: их материал взят из
// других планов). Суммы по единицам и источникам не складываются между собой.
type ProjectSpend struct {
	Shots  []ShotSpendBadge `json:"shots"`
	Totals []ProjectTotal   `json:"totals"`
	// Unpriced — планы с материалом вне приложения без цены или принятые без записи.
	Unpriced []string `json:"unpriced"`
	// Unknown — планы с отправками, списание которых неизвестно.
	Unknown []string `json:"unknown"`
	Videos  int      `json:"videos"`
	Images  int      `json:"images"`
	// Manual — видео, созданные вне приложения; OwnImages — свои опоры.
	Manual    int `json:"manual"`
	OwnImages int `json:"ownImages"`
	Rejected  int `json:"rejected"`
}

// ProjectSpendFor — production:projectSpend: расход всех планов реестра по журналу и живым
// попыткам. Без реестра — пустой расход. Только чтение.
func ProjectSpendFor(project string) (ProjectSpend, error) {
	entries, err := spend.Entries(project)
	if err != nil {
		return ProjectSpend{}, err
	}
	return projectSpend(project, registryShots(project), entries), nil
}

// registryShot — план реестра и признак производного.
type registryShot struct {
	id      string
	derived bool
}

// registryShots — планы plan/scenes.json по порядку; нечитаемый реестр — пусто.
func registryShots(project string) []registryShot {
	list, err := dynvalue.Iterate(dynvalue.Get(readJSON(filepath.Join(project, "plan", "scenes.json")), "scenes"))
	if err != nil {
		return nil
	}
	shots := []registryShot{}
	for _, scene := range list {
		if id, ok := dynvalue.Get(scene, "id").(string); ok && acceptedShotID.MatchString(id) {
			shots = append(shots, registryShot{id: id, derived: derivedshot.Source(scene) != ""})
		}
	}
	return shots
}

// projectSpend — расход клипа по планам shots и записям entries.
func projectSpend(project string, shots []registryShot, entries []spend.Entry) ProjectSpend {
	result := ProjectSpend{Shots: []ShotSpendBadge{}, Totals: []ProjectTotal{}, Unpriced: []string{}, Unknown: []string{}}
	for _, shot := range shots {
		if shot.derived {
			continue
		}
		summary := spend.Summarize(entries, shot.id, acceptedResult(project, shot.id))
		badge := badgeOf(shot.id, summary)
		result.Shots = append(result.Shots, badge)
		result.Videos += summary.Videos
		result.Images += summary.Images
		result.Manual += summary.Manual
		result.OwnImages += summary.OwnImages
		result.Rejected += summary.Rejected
		if summary.Unpriced > 0 {
			result.Unpriced = append(result.Unpriced, shot.id)
		}
		if summary.Unknown > 0 {
			result.Unknown = append(result.Unknown, shot.id)
		}
		for _, total := range summary.Totals {
			index := slices.IndexFunc(result.Totals, func(item ProjectTotal) bool {
				return sameText(item.Provider, total.Provider) && sameText(item.Unit, total.Unit)
			})
			if index < 0 {
				result.Totals = append(result.Totals, ProjectTotal{Total: spend.Total{Provider: total.Provider, Unit: total.Unit}, Shots: []string{}})
				index = len(result.Totals) - 1
			}
			result.Totals[index].Amount += total.Amount
			result.Totals[index].Shots = append(result.Totals[index].Shots, shot.id)
		}
	}
	return result
}

// badgeOf — бейдж расхода плана по его сводке.
func badgeOf(shot string, summary spend.Summary) ShotSpendBadge {
	return ShotSpendBadge{Shot: shot, Totals: summary.Totals, Unknown: summary.Unknown, Unpriced: summary.Unpriced, Missing: summary.Missing,
		Entries: len(summary.Entries)}
}

// sameText — оба значения отсутствуют или равны.
func sameText(a, b *string) bool {
	return (a == nil && b == nil) || (a != nil && b != nil && *a == *b)
}
