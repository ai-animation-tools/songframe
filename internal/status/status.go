// Package status вычисляет состояние проекта из файлов его папки (computeStatus оригинала и
// постобработка обработчика IPC projects:status). Состояние нигде не хранится: приложение,
// инструменты и агент видят одно и то же без синхронизации полей. Вычисление только читает
// проект; кэш хешей медиа живёт в памяти процесса (filedigest).
//
// Результат должен совпадать с Electron-оригиналом (commit 634fd94) на тех же файлах, включая
// повреждённые документы: доказательство — эталоны testdata/golden/status.
package status

import (
	"os"
	"path/filepath"
	"strings"

	"songframe-go/internal/acceptance"
	"songframe-go/internal/animatic"
	"songframe-go/internal/jscompat"
)

// Состояния проекта (ProjectState контракта).
const (
	StateInvalid      = "invalid"
	StateEmpty        = "empty"
	StateSourced      = "sourced"
	StateTimed        = "timed"
	StateScripted     = "scripted"
	StateInProduction = "in_production"
	StateComplete     = "complete"
)

// Тексты projectsTexts.main.status: выводятся пользователю дословно.
const (
	markerMissing       = "Нет plan/project.json с названием проекта."
	incompleteSources   = "source/manifest.json есть, но в нём нет трека, текста песни или идеи."
	damagedSources      = "source/manifest.json повреждён."
	timingLinesMissing  = "plan/audio/timing.json не содержит строк разметки."
	damagedCast         = "plan/cast.json повреждён."
	damagedTreatment    = "plan/treatment.json повреждён или пуст."
	damagedScenes       = "plan/scenes.json повреждён или не содержит сцен."
	animaticNotBuilt    = "Все сцены приняты, но полный аниматик ещё не собран."
	staleAnimatic       = "Аниматик собран по устаревшему реестру или входам: нужна пересборка."
	animaticNotApproved = "Аниматик собран, но не принят в plan/production-status.json."
)

func staleShots(ids []string) string {
	return "Постановка изменена после приёмки: " + strings.Join(ids, ", ") + ". Нужно новое производство этих планов."
}
func derivedShotsNeedReview(ids []string) string {
	return "Не подтверждена актуальность производных планов: " + strings.Join(ids, ", ") + ". Проверьте версию источника и приёмку этих планов."
}
func orphanKits(ids []string) string {
	return "Комплекты без сцены в реестре: " + strings.Join(ids, ", ") + "."
}

// Checks — признаки, из которых выведено состояние; показываются на странице проекта.
type Checks struct {
	Marker    bool `json:"marker"`
	Sources   bool `json:"sources"`
	Timing    bool `json:"timing"`
	Cast      bool `json:"cast"`
	Treatment bool `json:"treatment"`
	Scenes    bool `json:"scenes"`
	// ShotsTotal — число планов-объектов в реестре.
	ShotsTotal int `json:"shotsTotal"`
	// ShotsDone — планы, принятые по текущей постановке; без реестра — все комплекты с манифестом,
	// поэтому может превышать ShotsTotal (как в оригинале).
	ShotsDone        int  `json:"shotsDone"`
	AnimaticBuilt    bool `json:"animaticBuilt"`
	AnimaticFresh    bool `json:"animaticFresh"`
	AnimaticApproved bool `json:"animaticApproved"`
}

// ProjectStatus — ProjectStatus контракта frontend/src/shared/types.ts.
type ProjectStatus struct {
	// Path — путь в том виде, в каком его передали (без resolve), как в оригинале.
	Path  string `json:"path"`
	State string `json:"state"`
	// Name — название из plan/project.json либо basename пути для не-проекта.
	Name string `json:"name"`
	// AnimaticVideo — animatic_video маркера, если это строка.
	AnimaticVideo *string `json:"animaticVideo"`
	Checks        Checks  `json:"checks"`
	// Problems — что мешает перейти дальше; всегда массив, пустой у здорового проекта.
	Problems []string `json:"problems"`
}

// Marker — сведения plan/project.json, по которым папка считается проектом.
type Marker struct {
	Name          string
	AnimaticVideo *string
}

// ReadMarker — readProjectMarker: plan/project.json — объект с непустым строковым name.
func ReadMarker(path string) *Marker {
	data, ok := jscompat.ReadJSONFile(filepath.Join(path, "plan", "project.json"))
	object, isRecord := jscompat.AsObject(data)
	if !ok || !isRecord {
		return nil
	}
	name, isString := object.Value("name").(string)
	if !isString || name == "" {
		return nil
	}
	marker := &Marker{Name: name}
	if video, ok := object.Value("animatic_video").(string); ok {
		marker.AnimaticVideo = &video
	}
	return marker
}

// readJSON — readJson оригинала: (значение, true) или (nil, false) при отсутствии и ошибке.
func readJSON(path string) (any, bool) {
	return jscompat.ReadJSONFile(path)
}

// Compute — computeStatus с проверкой только входов сценария (reviewProblem без сценарного
// прохода). Полный результат projects:status даёт ComputeWith с проверкой сценарного прохода.
func Compute(path string) (ProjectStatus, error) {
	return ComputeWith(path, reviewProblem)
}

// ComputeWith — результат projects:status: computeStatus и проблема актуальности сценария
// review(path) (reviewProblem из ipc.ts оригинала). Проблема добавляется в конец списка и снимает
// свежесть и утверждение аниматика; завершённый проект возвращается в производство. Ошибка
// соответствует исключению оригинала, например на плане без строкового id.
func ComputeWith(path string, review func(string) string) (ProjectStatus, error) {
	status, err := ComputeBase(path)
	if err != nil {
		return ProjectStatus{}, err
	}
	if problem := review(path); problem != "" {
		status.Problems = append(status.Problems, problem)
		status.Checks.AnimaticFresh = false
		status.Checks.AnimaticApproved = false
		if status.State == StateComplete {
			status.State = StateInProduction
		}
	}
	return status, nil
}

// ComputeBase — computeStatus без проверки сценарного процесса; этим срезом сняты эталоны.
func ComputeBase(path string) (ProjectStatus, error) {
	result := ProjectStatus{Path: path, Problems: []string{}}
	var marker *Marker
	if jscompat.Exists(path) {
		marker = ReadMarker(path)
	}
	if marker == nil {
		result.State = StateInvalid
		result.Name = jscompat.Basename(path)
		result.Problems = append(result.Problems, markerMissing)
		return result, nil
	}
	checks := &result.Checks
	checks.Marker = true
	problems := &result.Problems

	manifestPath := filepath.Join(path, "source", "manifest.json")
	if manifest, ok := readJSON(manifestPath); ok {
		if jscompat.IsRecord(manifest) && jscompat.IsRecord(jscompat.Get(manifest, "track")) &&
			jscompat.IsRecord(jscompat.Get(manifest, "lyrics")) && jscompat.IsRecord(jscompat.Get(manifest, "idea")) {
			checks.Sources = true
		} else {
			*problems = append(*problems, incompleteSources)
		}
	} else if jscompat.Exists(manifestPath) {
		*problems = append(*problems, damagedSources)
	}

	timingPath := filepath.Join(path, "plan", "audio", "timing.json")
	if jscompat.Exists(timingPath) {
		timing, _ := readJSON(timingPath)
		lines, isArray := jscompat.AsArray(jscompat.Get(timing, "lines"))
		if jscompat.IsRecord(timing) && isArray && len(lines) > 0 {
			checks.Timing = true
		} else {
			*problems = append(*problems, timingLinesMissing)
		}
	}

	castPath := filepath.Join(path, "plan", "cast.json")
	cast, _ := readJSON(castPath)
	if jscompat.IsRecord(cast) && jscompat.IsArray(jscompat.Get(cast, "entities")) {
		checks.Cast = true
	} else if jscompat.Exists(castPath) {
		*problems = append(*problems, damagedCast)
	}
	treatmentPath := filepath.Join(path, "plan", "treatment.json")
	treatment, _ := readJSON(treatmentPath)
	if sequences, ok := jscompat.AsArray(jscompat.Get(treatment, "sequences")); jscompat.IsRecord(treatment) && ok && len(sequences) > 0 {
		checks.Treatment = true
	} else if jscompat.Exists(treatmentPath) {
		*problems = append(*problems, damagedTreatment)
	}

	scenesPath := filepath.Join(path, "plan", "scenes.json")
	var sceneIDs []string
	var registry any
	if jscompat.Exists(scenesPath) {
		data, err := os.ReadFile(scenesPath)
		if err != nil {
			// readFileSync вне try: например, scenes.json — каталог.
			return ProjectStatus{}, jscompat.FsError("read", "", err)
		}
		scenes, err := jscompat.Parse([]byte(jscompat.DecodeUTF8(data)))
		if err != nil {
			scenes = jscompat.Undefined
		}
		if list, ok := jscompat.AsArray(jscompat.Get(scenes, "scenes")); jscompat.IsRecord(scenes) && ok && len(list) > 0 {
			sceneIDs = []string{}
			for _, scene := range list {
				if jscompat.IsRecord(scene) {
					sceneIDs = append(sceneIDs, jscompat.ToString(jscompat.Get(scene, "id")))
				}
			}
			registry = scenes
			checks.Scenes = true
		} else {
			*problems = append(*problems, damagedScenes)
		}
	}
	checks.ShotsTotal = len(sceneIDs)

	shotsDir := filepath.Join(path, "assets", "shots")
	kits := 0
	if jscompat.Exists(shotsDir) {
		entries, err := jscompat.ReadDir(shotsDir)
		if err != nil {
			return ProjectStatus{}, err
		}
		done := map[string]bool{}
		var doneOrder []string
		for _, entry := range entries {
			if entry.IsDir() && jscompat.Exists(filepath.Join(shotsDir, entry.Name(), "manifest.json")) {
				done[entry.Name()] = true
				doneOrder = append(doneOrder, entry.Name())
			}
		}
		if len(sceneIDs) > 0 {
			for _, id := range sceneIDs {
				if done[id] {
					kits++
				}
			}
		} else {
			kits = len(doneOrder)
		}
		// Готов только комплект, принятый по текущей постановке: правило общее со страницами планов.
		if registry != nil {
			accepted, err := acceptance.Compute(path, registry)
			if err != nil {
				return ProjectStatus{}, err
			}
			if accepted.Problem != nil {
				*problems = append(*problems, *accepted.Problem)
			}
			var changed, derived []string
			for _, id := range sceneIDs {
				switch accepted.Accepted[id] {
				case acceptance.Completed:
					checks.ShotsDone++
				case acceptance.Stale:
					// Причина может относиться к версии источника: не выдаём её за изменение постановки.
					if accepted.Reasons[id] == acceptance.SceneChanged {
						changed = append(changed, id)
					} else {
						derived = append(derived, id)
					}
				}
			}
			if len(changed) > 0 {
				*problems = append(*problems, staleShots(changed))
			}
			if len(derived) > 0 {
				*problems = append(*problems, derivedShotsNeedReview(derived))
			}
		} else {
			checks.ShotsDone = len(doneOrder)
		}
		var orphans []string
		for _, id := range doneOrder {
			if len(sceneIDs) > 0 && !contains(sceneIDs, id) {
				orphans = append(orphans, id)
			}
		}
		if len(orphans) > 0 {
			*problems = append(*problems, orphanKits(orphans))
		}
	}

	// Главная страница и плеер используют одну проверку фактических входов и принятия сборки.
	view, err := animatic.Inspect(path)
	if err != nil {
		return ProjectStatus{}, err
	}
	checks.AnimaticBuilt = view.Built
	checks.AnimaticFresh = view.Built && view.Fresh
	checks.AnimaticApproved = view.Approved

	switch {
	case !checks.Sources:
		result.State = StateEmpty
	case !checks.Timing:
		result.State = StateSourced
	case !checks.Scenes:
		result.State = StateTimed
	case kits == 0:
		result.State = StateScripted
	case checks.ShotsDone < checks.ShotsTotal:
		result.State = StateInProduction
	case checks.AnimaticBuilt && checks.AnimaticFresh && checks.AnimaticApproved:
		result.State = StateComplete
	default:
		result.State = StateInProduction
		switch {
		case !checks.AnimaticBuilt:
			*problems = append(*problems, animaticNotBuilt)
		case !checks.AnimaticFresh:
			*problems = append(*problems, staleAnimatic)
		default:
			*problems = append(*problems, animaticNotApproved)
		}
	}
	result.Name = marker.Name
	result.AnimaticVideo = marker.AnimaticVideo
	return result, nil
}

func contains(items []string, value string) bool {
	for _, item := range items {
		if item == value {
			return true
		}
	}
	return false
}
