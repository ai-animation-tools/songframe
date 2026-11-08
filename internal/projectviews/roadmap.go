package projectviews

import (
	"math/big"
	"strings"

	"songframe-go/internal/pycompat"
	"songframe-go/internal/sceneregistry"
)

// Состояния строк ROADMAP в порядке диаграммы и таблицы готовности.
const (
	stateReady    = "Готово"
	stateStale    = "Постановка изменена"
	stateProgress = "В процессе"
	statePlanned  = "Запланировано"
)

// stateOrder — порядок ключей counts в progress.
var stateOrder = []string{stateReady, stateStale, stateProgress, statePlanned}

// mediaLabels — MEDIA_LABELS: подпись столбца «В полном монтаже» по виду кадра в сборке.
var mediaLabels = map[string]string{"video": "Видео", "card": "Карточка", "keyframes": "Опоры"}

// InProgress — in_progress(sources): планы с рабочим пакетом производства plan/batches/<папка> или
// plan/awaiting/<папка> (поле shot строкой в workflow.json); неразбираемый workflow.json
// пропускается (ValueError), ошибка чтения — исключение.
func InProgress(sources *Sources) (map[string]bool, error) {
	result := map[string]bool{}
	for _, path := range sources.Files() {
		parts := strings.Split(path, "/")
		if len(parts) != 4 || parts[0] != "plan" || (parts[1] != "batches" && parts[1] != "awaiting") || parts[3] != "workflow.json" {
			continue
		}
		workflow, err := sources.JSON(path)
		if err != nil {
			if pycompat.Is(err, pycompat.ValueError) {
				continue
			}
			return nil, err
		}
		if dict, ok := workflow.(*pycompat.Dict); ok {
			if shot, ok := dict.Value("shot").(string); ok {
				result[shot] = true
			}
		}
	}
	return result, nil
}

// quantizeHalfUp — format(d.quantize(Decimal("0.1"), rounding=ROUND_HALF_UP), "f") для
// неотрицательного конечного Decimal: одна цифра после точки, половина округляется вверх.
func quantizeHalfUp(value pycompat.Decimal) string {
	text := value.FormatF()
	whole, fraction, _ := strings.Cut(text, ".")
	if len(fraction) <= 1 {
		return whole + "." + fraction + strings.Repeat("0", 1-len(fraction))
	}
	digits := []byte(whole + fraction[:1])
	if fraction[1] >= '5' {
		index := len(digits) - 1
		for ; index >= 0; index-- {
			if digits[index] == '9' {
				digits[index] = '0'
				continue
			}
			digits[index]++
			break
		}
		if index < 0 {
			digits = append([]byte{'1'}, digits...)
		}
	}
	return string(digits[:len(digits)-1]) + "." + string(digits[len(digits)-1:])
}

// percent — percent(value, total): доля в процентах с одной цифрой после запятой («37,5%»);
// при нулевом total — «0,0%».
func percent(value, total *big.Int) (string, error) {
	result := pycompat.DecimalInt(0)
	if total.Sign() != 0 {
		numerator, err := pycompat.NewDecimal(pycompat.IntFromBig(new(big.Int).Mul(value, big.NewInt(100))))
		if err != nil {
			return "", err
		}
		divisor, err := pycompat.NewDecimal(pycompat.IntFromBig(total))
		if err != nil {
			return "", err
		}
		if result, err = numerator.Div(divisor); err != nil {
			return "", err
		}
	}
	return strings.ReplaceAll(quantizeHalfUp(result), ".", ",") + "%", nil
}

// clockFrames — clock((Decimal(frames) / fps).quantize(Decimal("0.1"), ROUND_HALF_UP)).
func clockFrames(frames *big.Int, fps any) (string, error) {
	value, err := pycompat.NewDecimal(pycompat.IntFromBig(frames))
	if err != nil {
		return "", err
	}
	divisor, err := pycompat.DecimalOperand(fps, "/")
	if err != nil {
		return "", err
	}
	quotient, err := value.Div(divisor)
	if err != nil {
		return "", err
	}
	return sceneregistry.Clock(quantizeHalfUp(quotient))
}

// progress — progress(items, states, fps): раздел «Готовность проекта» — диаграмма Mermaid без
// нулевых секторов, таблица состояний (строка изменённой постановки — только при таких планах) и
// готовность по хронометражу.
func progress(items []*pycompat.Dict, states map[string]string, fps any) ([]string, error) {
	counts := map[string]int64{}
	for _, scene := range items {
		counts[states[scene.Value("id").(string)]]++
	}
	total := sumFrames(items, nil)
	ready := sumFrames(items, func(scene *pycompat.Dict) bool { return states[scene.Value("id").(string)] == stateReady })
	planCount := big.NewInt(int64(len(items)))
	lines := []string{"## Готовность проекта", ""}
	if len(items) > 0 {
		lines = append(lines, "```mermaid", "pie showData", "    title Состояние планов")
		for _, state := range stateOrder {
			if counts[state] == 0 {
				continue
			}
			share, err := percent(big.NewInt(counts[state]), planCount)
			if err != nil {
				return nil, err
			}
			count := pycompat.NewInt(counts[state]).String()
			lines = append(lines, `    "`+state+" — "+share+`" : `+count)
		}
		lines = append(lines, "```", "")
	}
	lines = append(lines, "| Состояние | Планов | Доля от общего числа |", "| --- | ---: | ---: |")
	for _, state := range stateOrder {
		if counts[state] == 0 && state == stateStale {
			continue
		}
		share, err := percent(big.NewInt(counts[state]), planCount)
		if err != nil {
			return nil, err
		}
		lines = append(lines, "| "+state+" | "+pycompat.NewInt(counts[state]).String()+" | "+share+" |")
	}
	readyTime, err := clockFrames(ready, fps)
	if err != nil {
		return nil, err
	}
	totalTime, err := clockFrames(total, fps)
	if err != nil {
		return nil, err
	}
	readyShare, err := percent(ready, total)
	if err != nil {
		return nil, err
	}
	return append(lines,
		"",
		"**По хронометражу готово "+readyShare+"** — "+readyTime+" из "+totalTime+".",
		"Доли по планам считаются по их количеству, по хронометражу — по "+
			"кадровым границам. Готов план, выбранный комплект которого в assets "+
			"принят по текущей постановке; после её правки план требует нового производства.",
		"",
	), nil
}

// animaticState — свежесть и принятие текущей полной сборки для ROADMAP.
type animaticState struct {
	fresh    bool
	approved bool
	compiled map[string]any
}

// readAnimatic — current_animatic из plan/production-status.json, его манифест и свежесть:
// хеш реестра, поля проекта и все записанные хеши медиа совпадают с файлами; принятие —
// approved_animatic с тем же video_sha256.
func readAnimatic(sources *Sources, project *pycompat.Dict, work any) (animaticState, error) {
	result := animaticState{compiled: map[string]any{}}
	latest, err := get(work, "current_animatic")
	if err != nil {
		return result, err
	}
	present, err := sources.Contains(latest)
	if err != nil {
		return result, err
	}
	var manifest any = pycompat.NewDict()
	if present {
		path := latest.(string)
		document, err := sources.JSON(path)
		if err != nil {
			return result, err
		}
		shots, err := get(document, "shots")
		if err != nil {
			return result, err
		}
		list, err := pycompat.Iter(shots)
		if err != nil {
			return result, err
		}
		for _, shot := range list {
			id, err := get(shot, "id")
			if err != nil {
				return result, err
			}
			hash, err := pycompat.HashKey(id)
			if err != nil {
				return result, err
			}
			result.compiled[hash] = shot
		}
		if manifest, err = sources.JSON(path); err != nil {
			return result, err
		}
	}
	hashes, err := dictGet(manifest, "source_hashes", nil)
	if err != nil {
		return result, err
	}
	if present {
		fresh, err := animaticFresh(sources, project, latest.(string), hashes)
		if err != nil {
			return result, err
		}
		result.fresh = fresh
	}
	if result.fresh {
		status, err := dictGet(work, "current_animatic_status", nil)
		if err != nil {
			return result, err
		}
		video, err := dictGet(manifest, "video_sha256", nil)
		if err != nil {
			return result, err
		}
		if pycompat.Equal(status, "approved") && pycompat.Truthy(video) {
			approvedValue, err := dictGet(work, "approved_animatic", nil)
			if err != nil {
				return result, err
			}
			if !pycompat.Truthy(approvedValue) {
				approvedValue = pycompat.NewDict()
			}
			approvedSHA, err := dictGet(approvedValue, "video_sha256", nil)
			if err != nil {
				return result, err
			}
			result.approved = pycompat.Equal(approvedSHA, video)
		}
	}
	return result, nil
}

// animaticFresh — свежесть аниматика после проверки наличия манифеста. Условия проверяются по
// порядку с коротким замыканием: от порядка зависит, какое исключение чтения возникнет.
func animaticFresh(sources *Sources, project *pycompat.Dict, latest string, hashes any) (bool, error) {
	document, err := sources.JSON(latest)
	if err != nil {
		return false, err
	}
	saved, err := dictGet(document, "scene_registry_sha256", nil)
	if err != nil {
		return false, err
	}
	registry, err := sources.TextSHA("plan/scenes.json")
	if err != nil {
		return false, err
	}
	if !pycompat.Equal(saved, registry) {
		return false, nil
	}
	if document, err = sources.JSON(latest); err != nil {
		return false, err
	}
	match, err := ProjectInputsMatch(document, project, true)
	if err != nil || !match {
		return false, err
	}
	dict, ok := hashes.(*pycompat.Dict)
	if !ok || dict.Len() == 0 {
		return false, nil
	}
	for _, name := range dict.Keys() {
		if !sources.Has(name) {
			return false, nil
		}
		digest, err := sources.Digest(name)
		if err != nil {
			return false, err
		}
		if !pycompat.Equal(digest, dict.Value(name)) {
			return false, nil
		}
	}
	return true, nil
}

// Render — render(sources): ROADMAP.md — текущее состояние клипа из реестра, комплектов assets,
// рабочих пакетов и принятия (plan/production-status.json), без копий постановки из Markdown.
// Принятие плана — общее правило shot_acceptance (sceneregistry.ShotAcceptance).
func Render(sources *Sources, prepared *Prepared) (string, error) {
	project, err := projectFile(sources)
	if err != nil {
		return "", err
	}
	workValue, err := sources.JSON(sceneregistry.ProductionStatus)
	if err != nil {
		return "", err
	}
	animatic, err := readAnimatic(sources, project, workValue)
	if err != nil {
		return "", err
	}
	buildState := "Сборка устарела относительно исходников; требуется пересборка."
	if animatic.fresh {
		buildState = "Полная сборка ожидает просмотра."
		if animatic.approved {
			buildState = "Полная сборка принята."
		}
	}
	active, err := InProgress(sources)
	if err != nil {
		return "", err
	}
	// readAnimatic уже взял work["current_animatic"], значит work — словарь.
	work := workValue.(*pycompat.Dict)
	accepted, err := sceneregistry.AcceptedFingerprints(work)
	if err != nil {
		return "", err
	}
	reviews := pycompat.NewDict()
	shotsValue, _ := pycompat.DictGet(work, "shots", pycompat.NewDict())
	if shots, ok := shotsValue.(*pycompat.Dict); ok {
		for _, sid := range shots.Keys() {
			if entry, ok := shots.Value(sid).(*pycompat.Dict); ok && entry.Has("source_review") {
				reviews.Set(sid, entry.Value("source_review"))
			}
		}
	}
	root := sources.Root
	acceptance, err := sceneregistry.ShotAcceptance(prepared.Data, sceneregistry.AcceptanceInput{
		Kits:             prepared.Packages,
		Accepted:         accepted,
		Initial:          prepared.Initial,
		SourceSnapshot:   func(shot string) (string, bool) { return sceneregistry.SourceVideoSnapshot(root, shot, false) },
		SourceReviews:    reviews,
		AcceptedSnapshot: func(shot string) (string, bool) { return sceneregistry.SourceVideoSnapshot(root, shot, true) },
	})
	if err != nil {
		return "", err
	}
	states := map[string]string{}
	ready := 0
	for _, scene := range prepared.Items {
		sid := scene.Value("id").(string)
		switch acceptance.States.Value(sid) {
		case sceneregistry.Completed:
			states[sid] = stateReady
			ready++
		case sceneregistry.Stale:
			states[sid] = stateStale
		default:
			states[sid] = statePlanned
			if active[sid] {
				states[sid] = stateProgress
			}
		}
	}
	name := pycompat.Str(project.Value("name"))
	lines := []string{
		"# ROADMAP — состояние клипа «" + name + "»",
		"",
		"> Автоматическое представление plan/scenes.json, локальных " +
			"ассетов и состояния работ. Вручную не редактировать.",
		"",
		"Всего " + pycompat.NewInt(int64(len(prepared.Items))).String() + " планов; готовы " + pycompat.NewInt(int64(ready)).String() +
			". [Текущий полный монтаж](plan/animatic/latest/README.md). " + buildState,
		"",
	}
	section, err := progress(prepared.Items, states, prepared.Data.Value("fps"))
	if err != nil {
		return "", err
	}
	lines = append(lines, section...)
	lines = append(lines, "## Планы", "",
		"| План | Тайминг | Действие | Состояние | Материалы | В полном монтаже |",
		"| --- | --- | --- | --- | --- | --- |",
	)
	for _, scene := range prepared.Items {
		row, err := roadmapRow(sources, prepared, scene, states, animatic)
		if err != nil {
			return "", err
		}
		lines = append(lines, row)
	}
	lines = append(lines,
		"",
		"Изменять постановку и монтажные границы только в [реестре "+
			"сцен](plan/scenes.json). [Сценарий](source/description.md) "+
			"описывает общую историю. Генерации и обработка сохраняются в "+
			"локальных манифестах assets. Незавершённая работа — в рабочих "+
			"пакетах `plan/batches` и `plan/awaiting` (страница «Производство»).",
		"",
		"Представления обновляет приложение: кнопка «Пересобрать карточки» в строке "+
			"«Карточки и списки» на странице «Проверки»; проверка той же строки "+
			"находит рассинхрон.",
		"",
	)
	return strings.Join(lines, "\n"), nil
}

// roadmapRow — строка таблицы планов ROADMAP: тайминг, действие, состояние, ссылки на постановку,
// манифест и видео комплекта и вид кадра в полном монтаже.
func roadmapRow(sources *Sources, prepared *Prepared, scene *pycompat.Dict, states map[string]string, animatic animaticState) (string, error) {
	sid := scene.Value("id").(string)
	link := "[Постановка](plan/storyboard.md#" + strings.ToLower(sid) + ")"
	if pkg := prepared.Packages.Value(sid); pycompat.Truthy(pkg) {
		path, err := getPath(pkg, "accepted_edit", "video", "path")
		if err != nil {
			return "", err
		}
		video, err := concat("assets/shots/"+sid+"/", path)
		if err != nil {
			return "", err
		}
		if err := sources.Require(video); err != nil {
			return "", err
		}
		link += " · [Манифест](assets/shots/" + sid + "/manifest.json) · [Видео](" + video + ")"
	}
	included := "Устаревшая сборка"
	if animatic.fresh {
		hash, _ := pycompat.HashKey(sid)
		var compiled any = pycompat.NewDict()
		if found, ok := animatic.compiled[hash]; ok {
			compiled = found
		}
		media, err := dictGet(compiled, "media", nil)
		if err != nil {
			return "", err
		}
		included = "Карточка"
		if text, ok := media.(string); ok && mediaLabels[text] != "" {
			included = mediaLabels[text]
		} else if _, err := pycompat.HashKey(media); err != nil {
			return "", err
		}
	}
	label, err := DerivedLabel(scene, " · ")
	if err != nil {
		return "", err
	}
	values := []string{}
	for _, key := range []string{"interval", "duration", "action"} {
		value, err := get(scene, key)
		if err != nil {
			return "", err
		}
		values = append(values, pycompat.Str(value))
	}
	action, _ := get(scene, "action")
	return "| **" + sid + "**" + label + " | " + values[0] + " · " + values[1] + " с | " +
		Cell(action) + " | **" + states[sid] + "** | " + link + " | " + included + " |", nil
}
