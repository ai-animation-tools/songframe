// Package montage — перенос src/main/montage.ts, montage-video.ts и montage-recovery.ts оригинала:
// каталог ручного монтажа (ViewProject), черновики plan/montage/<uuid>.json (Load/Save), экспорт
// пробы заданием build_review (Export), применение к сценам заданием apply_montage (Apply), путь и
// копия готовой пробы (VideoPath/CopyVideo) и восстановление прерванной публикации журнала
// plan/montage-history без инструмента (RecoverApplications/RecoverProjects).
//
// Черновик хранится деревом jscompat: неизвестные поля, порядок ключей и форма чисел сохраняются,
// а записанный JSON совпадает с writeLocalJson байт в байт (эталон testdata/golden/montage).
// Применение черновика к файлам сцен выполняет internal/applymontage.
package montage

import (
	"context"
	"encoding/json"
	"errors"
	"os"
	"path/filepath"

	"songframe-go/internal/jobs"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/projectfs"
	"songframe-go/internal/tools"
)

// Starter — запуск задания общим менеджером (jobs.Manager.Start); тесты подменяют его записью
// параметров.
type Starter interface {
	Start(spec jobs.Spec) (jobs.Info, error)
}

// Service — Montage оригинала: операции, которым нужен менеджер заданий (экспорт и применение).
// Сам сервис состояния не хранит.
type Service struct{ jobs Starter }

// New связывает монтаж с менеджером заданий.
func New(starter Starter) *Service { return &Service{jobs: starter} }

// Export — результат экспорта: задание сборки и путь будущего MP4 от корня проекта.
type Export struct {
	Job   jobs.Info `json:"job"`
	Video string    `json:"video"`
}

// draftPath — idPath(project, id): plan/montage/<uuid>.json; не-UUID — ошибка.
func draftPath(project, id string) (string, error) {
	if !uuidPattern.MatchString(id) {
		return "", errors.New(textInvalidDraftID)
	}
	return filepath.Join(project, "plan", "montage", id+".json"), nil
}

// ParseDraft разбирает черновик из JSON renderer с порядком ключей и неизвестными полями.
func ParseDraft(data json.RawMessage) (any, error) {
	if len(data) == 0 {
		return jscompat.Undefined, nil
	}
	return jscompat.Parse(data)
}

// Load — Montage.load(project, id): сохранённый черновик после проверки структуры и файлов.
func Load(project, id string) (any, error) {
	path, err := draftPath(project, id)
	if err != nil {
		return nil, err
	}
	value, err := readObject(path, labelDraft)
	if err != nil {
		return nil, err
	}
	if _, err := validate(project, value, false, nil, true); err != nil {
		return nil, err
	}
	return value, nil
}

// writeDraft — writeLocalJson(join(project, rel), value) через шлюз записи проекта: при
// незавершённой многофайловой публикации черновик не пишется поверх смешанных версий файлов.
func writeDraft(project, rel string, value any) error {
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	return projectfs.WriteFile(filepath.Join(project, filepath.FromSlash(rel)), encode(value), 0)
}

// Save — Montage.save(project, draft, id): незавершённый черновик допустим (длины сверяются перед
// экспортом и применением). Перезаписываемый файл проверяется только структурно: устаревшие пути
// прежней версии не мешают сохранить исправленный черновик. id nil — новый UUID.
func Save(project string, draft any, id *string) (Saved, error) {
	name := RandomUUID()
	if id != nil {
		name = *id
	}
	path, err := draftPath(project, name)
	if err != nil {
		return Saved{}, err
	}
	if _, err := validate(project, draft, false, nil, true); err != nil {
		return Saved{}, err
	}
	if jscompat.Exists(path) {
		previous, err := readObject(path, labelDraft)
		if err != nil {
			return Saved{}, err
		}
		if _, err := validate(project, previous, false, nil, false); err != nil {
			return Saved{}, err
		}
	}
	if err := writeDraft(project, "plan/montage/"+name+".json", draft); err != nil {
		return Saved{}, err
	}
	info, err := os.Stat(path)
	if err != nil {
		return Saved{}, jscompat.FsError("stat", path, err)
	}
	return Saved{ID: name, Name: jscompat.Get(draft, "name").(string), UpdatedAt: isoTime(info)}, nil
}

// RemoveDraft удаляет сохранённый черновик plan/montage/<id>.json. В оригинале этого действия нет:
// черновики только копились. Применённые сцены от файла не зависят, история применения хранит
// собственную копию draft.json, поэтому удаление не меняет ни сцены, ни возможность восстановления.
// Уже отсутствующий файл — не ошибка: цель действия достигнута.
func RemoveDraft(project, id string) error {
	path, err := draftPath(project, id)
	if err != nil {
		return err
	}
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !os.IsNotExist(err) {
		return jscompat.FsError("unlink", path, err)
	}
	return nil
}

// Export — Montage.export(project, draft): полный черновик (длины, сцены, трек) записывается в
// plan/batches/review-manual-<uuid>/montage.json вместе с рецептом review-spec.json, и запускается
// задание review с шагом build_review. Пути рецепта остаются от корня проекта; инструменту
// передаются абсолютные --spec и --output.
func (s *Service) Export(project string, draft any) (Export, error) {
	view, err := ViewProject(project)
	if err != nil {
		return Export{}, err
	}
	checked, err := validate(project, draft, true, view, true)
	if err != nil {
		return Export{}, err
	}
	folder := "plan/batches/review-manual-" + RandomUUID()
	spec := folder + "/review-spec.json"
	video := folder + "/review.mp4"
	if err := writeDraft(project, folder+"/montage.json", draft); err != nil {
		return Export{}, err
	}
	shots := &jscompat.Array{Items: []any{}}
	for _, clip := range checked.clips {
		shot := jscompat.NewObject()
		for _, key := range []string{"scene", "path", "kind", "source_start_frame", "source_end_frame_exclusive"} {
			shot.Set(key, clip.Value(key))
		}
		shots.Items = append(shots.Items, shot)
	}
	audio := jscompat.NewObject()
	audio.Set("path", checked.audio.Value("path"))
	audio.Set("start_frame", checked.audio.Value("start_frame"))
	recipe := jscompat.NewObject()
	recipe.Set("schema_version", 1.0)
	recipe.Set("shots", shots)
	recipe.Set("audio", audio)
	if err := writeDraft(project, spec, recipe); err != nil {
		return Export{}, err
	}
	args := []string{"--spec", filepath.Join(project, filepath.FromSlash(spec)), "--output", filepath.Join(project, filepath.FromSlash(video))}
	job, err := s.jobs.Start(jobs.Spec{
		Kind: jobs.KindReview, Title: textExportTitle(checked.name), Project: project,
		Steps: []jobs.Step{ToolStep(project, "build_review", textExportStep, args)},
	})
	if err != nil {
		return Export{}, err
	}
	return Export{Job: job, Video: video}, nil
}

// Apply — Montage.apply(project, draft): полный черновик со снимком текущих реестра и манифестов
// выбранных сцен записывается в plan/batches/apply-manual-<uuid>/montage.json, и запускается
// задание tool с шагом apply_montage --spec <относительный путь>. Устаревший снимок — ошибка до
// записи. Проверку сценария (reviewProblem) выполняет сервис приложения.
func (s *Service) Apply(project string, draft any) (jobs.Info, error) {
	view, err := ViewProject(project)
	if err != nil {
		return jobs.Info{}, err
	}
	checked, err := validate(project, draft, true, view, true)
	if err != nil {
		return jobs.Info{}, err
	}
	if !jscompat.StrictEqual(checked.object.Value("base_scenes_sha256"), view.ScenesSha256) {
		return jobs.Info{}, errors.New(textRegistryChanged)
	}
	snapshot, _ := jscompat.AsObject(checked.object.Value("base_manifest_sha256"))
	for _, clip := range checked.clips {
		scene := clip.Value("scene").(string)
		current, ok := view.manifests[scene]
		if !ok || current == "" || !jscompat.StrictEqual(snapshot.Value(scene), current) {
			return jobs.Info{}, errors.New(textManifestsChanged)
		}
	}
	spec := "plan/batches/apply-manual-" + RandomUUID() + "/montage.json"
	if err := writeDraft(project, spec, draft); err != nil {
		return jobs.Info{}, err
	}
	return s.jobs.Start(jobs.Spec{
		Kind: jobs.KindTool, Title: textApplyTitle(checked.name), Project: project,
		Steps: []jobs.Step{ToolStep(project, "apply_montage", textApplyStep, []string{"--spec", spec})},
	})
}

// ToolStep — шаг задания с инструментом, выполняемым в процессе (tools.RunContext): потоки — в
// журнал, ненулевой код — сбой шага с текстом stderr (или stdout), отмена — остановка.
func ToolStep(project, tool, label string, args []string) jobs.Step {
	return jobs.Step{
		Tool: tool, Label: label, Args: args,
		Run: func(ctx context.Context, journal *jobs.StepContext) error {
			result, err := tools.RunContext(ctx, project, tool, args)
			if err != nil {
				return err
			}
			journal.Log(result.Stdout)
			journal.Log(result.Stderr)
			if ctx.Err() != nil || result.Code == nil {
				return &jobs.StepError{Code: -1, Message: jobs.StoppedMessage, Err: ctx.Err()}
			}
			if *result.Code == 0 {
				return nil
			}
			message := jscompat.Trim(result.Stderr)
			if message == "" {
				message = jscompat.Trim(result.Stdout)
			}
			return &jobs.StepError{Code: *result.Code, Message: message}
		},
	}
}
