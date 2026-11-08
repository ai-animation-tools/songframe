// Package production ведёт страницу «Производство»: вид планов и рабочих пакетов по файлам
// проекта, решения пользователя (через shot_workflow), согласование стоимости и платную отправку
// зафиксированного запроса, получение результата, повтор по сохранённому запросу и приёмку в assets. Длинные операции — задания internal/jobs,
// инструменты комплекса вызываются в процессе через internal/tools.
//
// Этот файл — срез вида, нужный оценке сохранения сценария (scenario.saveImpact): состояние плана
// и признак «есть принятый комплект или пакет» по тем же правилам пакета, что у полного вида.
package production

import (
	"path/filepath"
	"sort"

	"songframe/internal/acceptance"
	"songframe/internal/dynvalue"
)

// Состояния плана ShotProductionState.
const (
	StatePlanned   = "planned"
	StateProgress  = "progress"
	StateCompleted = "completed"
	StateStale     = "stale"
	StateUnknown   = "unknown"
)

// ShotState — состояние плана, нужное оценке сохранения сценария.
type ShotState struct {
	// State — состояние плана, как на странице «Производство».
	State string
	// Produced — есть принятый комплект (asset) или хотя бы один пакет плана.
	Produced bool
}

// ShotStates — состояние каждого плана сохранённого реестра plan/scenes.json по тем же
// правилам, что поле State в ViewProduction, и наличие комплекта/пакетов. Без реестра — пусто.
// Ключ — id плана строкой (dynvalue.ToString). Ничего не пишет.
func ShotStates(project string) (map[string]ShotState, error) {
	result := map[string]ShotState{}
	scenes := readJSON(filepath.Join(project, "plan", "scenes.json"))
	if !dynvalue.Truthy(scenes) {
		return result, nil
	}
	// Отпечатки сохранённого реестра по кастингу проекта (CurrentShotFingerprint), один раз за вызов.
	fingerprint := projectFingerprint(project)
	var packages []*PackageView
	for _, base := range []string{"batches", "awaiting"} {
		folder := filepath.Join(project, "plan", base)
		if !dynvalue.Exists(folder) {
			continue
		}
		entries, err := dynvalue.ReadDir(folder)
		if err != nil {
			return nil, err
		}
		names := make([]string, 0, len(entries))
		for _, entry := range entries {
			if entry.IsDir() {
				names = append(names, entry.Name())
			}
		}
		sort.Strings(names)
		for _, name := range names {
			info, err := readPackage(project, filepath.Join(folder, name), fingerprint)
			if err != nil {
				return nil, err
			}
			if info != nil {
				packages = append(packages, info)
			}
		}
	}
	if _, ok := dynvalue.AsArray(dynvalue.Get(scenes, "sequences")); !ok {
		return nil, &dynvalue.TypeError{Message: "scenes.sequences.map is not a function"}
	}
	accepted, err := acceptance.Compute(project, scenes)
	if err != nil {
		return nil, err
	}
	list, err := dynvalue.Iterate(dynvalue.Get(scenes, "scenes"))
	if err != nil {
		return nil, err
	}
	for _, scene := range list {
		rawID, err := dynvalue.Prop(scene, "id")
		if err != nil {
			return nil, err
		}
		id, err := dynvalue.PathArg("path", rawID)
		if err != nil {
			return nil, err
		}
		manifest := readJSON(filepath.Join(project, "assets", "shots", id, "manifest.json"))
		hasManifest := dynvalue.Truthy(manifest)
		mine, troubled := 0, false
		for _, item := range packages {
			if item.Shot == id {
				mine++
				troubled = troubled || len(item.Problems) > 0
			}
		}
		state := StatePlanned
		if mine > 0 {
			state = StateProgress
		}
		if hasManifest {
			state = StateStale
			if value, ok := accepted.Accepted[id]; ok {
				state = value
			}
		} else if troubled {
			state = StateUnknown
		}
		result[dynvalue.ToString(rawID)] = ShotState{State: state, Produced: hasManifest || mine > 0}
	}
	return result, nil
}
