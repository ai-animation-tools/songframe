package projectgit

import (
	"context"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"strings"

	"songframe/internal/dynvalue"
	"songframe/internal/projectfs"
	"songframe/internal/scenesave"
	"songframe/internal/sceneviews"
)

// restorePaths — файлы-источники разделов, которые можно вернуть к точке. Производные
// представления не возвращаются: их пересобирает приложение по источникам. Медиа (assets/,
// source/) и производство не возвращаются вовсе: платные оригиналы и принятые комплекты
// откатываются только вручную, чтобы возврат раздела их не потерял.
var restorePaths = map[Section][]string{
	SectionTiming:   {"plan/audio/timing.json"},
	SectionCast:     {"plan/cast.json"},
	SectionScenario: {"plan/treatment.json", "plan/scenes.json", "plan/scenario-workflow.json"},
}

// RestoreResult — итог возврата раздела. ViewsError — почему не удалось пересобрать производные
// представления после возврата (сам возврат при этом выполнен; пересобрать можно на «Проверках»).
type RestoreResult struct {
	Status     Status `json:"status"`
	ViewsError string `json:"viewsError"`
}

// resolvePoint — полный хеш точки или ошибка, если такого коммита нет.
func resolvePoint(ctx context.Context, project, point string) (string, error) {
	if strings.HasPrefix(point, "-") || point == "" {
		return "", fmt.Errorf(textPointMissing, point)
	}
	out, err := run(ctx, project, "rev-parse", "--verify", "--quiet", point+"^{commit}")
	if err != nil {
		return "", fmt.Errorf(textPointMissing, point)
	}
	return strings.TrimSpace(string(out)), nil
}

// existsAt — есть ли файл path в точке hash.
func existsAt(ctx context.Context, project, hash, path string) bool {
	_, err := run(ctx, project, "cat-file", "-e", hash+":"+path)
	return err == nil
}

// Restore возвращает файлы-источники раздела к точке. Порядок: проверка шлюза записи (нет
// незавершённых публикаций), автоматическая точка с текущим состоянием (без неё возврат не
// выполняется: пользователь должен иметь путь назад), затем файлы раздела берутся из точки; файл,
// которого в точке не было, удаляется. Результат остаётся несохранённым: его видно в статусе, и
// пользователь сохраняет точку сам. После возврата пересобираются производные представления.
func Restore(ctx context.Context, project, point string, section Section) (RestoreResult, error) {
	mu.Lock()
	defer mu.Unlock()
	paths, ok := restorePaths[section]
	if !ok {
		return RestoreResult{}, fmt.Errorf(textSectionNotRestorable, section)
	}
	if !repository(ctx, project) {
		return RestoreResult{}, errors.New(textNotRepository)
	}
	hash, err := resolvePoint(ctx, project, point)
	if err != nil {
		return RestoreResult{}, err
	}
	if err := projectfs.CheckWrite(project); err != nil {
		return RestoreResult{}, err
	}
	if err := checkpoint(ctx, project, operationTexts[OperationRestore]); err != nil {
		return RestoreResult{}, err
	}
	for _, path := range paths {
		if existsAt(ctx, project, hash, path) {
			if _, err := run(ctx, project, "restore", "--source="+hash, "--worktree", "--", path); err != nil {
				return RestoreResult{}, err
			}
			continue
		}
		if err := os.Remove(filepath.Join(project, filepath.FromSlash(path))); err != nil && !errors.Is(err, os.ErrNotExist) {
			return RestoreResult{}, err
		}
	}
	result := RestoreResult{}
	if _, err := sceneviews.Update(project, false); err != nil {
		var missing *sceneviews.MissingInputError
		if !errors.As(err, &missing) {
			result.ViewsError = err.Error()
		}
	}
	result.Status, err = status(ctx, project)
	return result, err
}

// ScenarioComparison — чем сценарий точки отличается от текущего сохранённого, в терминах планов.
// Shots — планы точки, которые при возврате изменятся или появятся, с причиной и текущим
// производственным состоянием (как предупреждение о сохранении сценария); Removed — планы, которых
// в точке нет (при возврате исчезнут). Missing — в точке нет plan/scenes.json.
type ScenarioComparison struct {
	Missing bool                   `json:"missing"`
	Shots   []scenesave.ImpactShot `json:"shots"`
	Removed []string               `json:"removed"`
}

// CompareScenario сравнивает plan/scenes.json точки с текущим файлом. Логика причин — та же, что
// у предупреждения о сохранении сценария (scenesave.SaveImpact): версия точки рассматривается как
// черновик, который заменил бы текущий реестр. Начальные состояния героев берутся из текущего
// кастинга, поэтому сравнение показывает последствия возврата одного сценария. Ничего не пишет.
func CompareScenario(ctx context.Context, project, point string) (ScenarioComparison, error) {
	mu.Lock()
	defer mu.Unlock()
	result := ScenarioComparison{Shots: []scenesave.ImpactShot{}, Removed: []string{}}
	if !repository(ctx, project) {
		return result, errors.New(textNotRepository)
	}
	hash, err := resolvePoint(ctx, project, point)
	if err != nil {
		return result, err
	}
	if !existsAt(ctx, project, hash, "plan/scenes.json") {
		result.Missing = true
		return result, nil
	}
	raw, err := run(ctx, project, "show", hash+":plan/scenes.json")
	if err != nil {
		return result, err
	}
	draft, err := dynvalue.Parse([]byte(dynvalue.DecodeUTF8(raw)))
	if err != nil {
		return result, fmt.Errorf(textPointScenesInvalid, err.Error())
	}
	impact, err := scenesave.SaveImpact(project, draft)
	if err != nil {
		return result, err
	}
	result.Shots = impact.Shots
	inPoint := map[string]bool{}
	for _, id := range sceneIDs(draft) {
		inPoint[id] = true
	}
	current, _ := dynvalue.ReadJSONFile(filepath.Join(project, "plan", "scenes.json"))
	for _, id := range sceneIDs(current) {
		if !inPoint[id] {
			result.Removed = append(result.Removed, id)
		}
	}
	return result, nil
}

// sceneIDs — коды планов реестра в его порядке.
func sceneIDs(registry any) []string {
	list, _ := dynvalue.AsArray(dynvalue.Get(registry, "scenes"))
	ids := make([]string, 0, len(list))
	for _, scene := range list {
		if id := dynvalue.ToString(dynvalue.Get(scene, "id")); id != "" {
			ids = append(ids, id)
		}
	}
	return ids
}
