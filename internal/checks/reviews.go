package checks

import (
	"context"
	"errors"
	"math"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strings"
	"sync"
	"time"

	"songframe-go/internal/builtoutput"
	"songframe-go/internal/jobs"
	"songframe-go/internal/jscompat"
	"songframe-go/internal/projectfs"
	"songframe-go/internal/tools"
)

// Пробы стыков (checks.buildReview, listReviews, removeReview из src/main/checks.ts оригинала):
// сборка — задание вида review с одним шагом build_review в новую папку plan/batches/review-…;
// список — MP4 внутри plan/batches с одноимённым JSON рецепта; удаление — только MP4 и рецепт
// найденной пробы, опустевшая папка тоже удаляется (иначе её найдёт check_workspace).

// ReviewOptions — ReviewOptions контракта: коды планов подряд по шкале и режим без кодирования.
type ReviewOptions struct {
	Shots    []string `json:"shots"`
	PlanOnly bool     `json:"planOnly"`
}

// ReviewInfo — ReviewInfo контракта: собранная проба и её рецепт. Пути абсолютные (папка
// проекта, как её передал renderer), CreatedAt — время изменения MP4 в ISO UTC с миллисекундами.
type ReviewInfo struct {
	Dir         string   `json:"dir"`
	Video       string   `json:"video"`
	Manifest    string   `json:"manifest"`
	Shots       []string `json:"shots"`
	TotalFrames float64  `json:"totalFrames"`
	CreatedAt   string   `json:"createdAt"`
}

// shotID — SHOT_ID оригинала: M05 или M05.1.
var shotID = regexp.MustCompile(`^M\d{2}(?:\.\d+)?$`)

// Now — время для имени папки пробы (подменяется в тестах). Метка — местное время, как stamp().
var Now = time.Now

// stamp — stamp() оригинала: ГГГГММДД-ЧЧММСС местного времени.
func stamp() string { return Now().Format("20060102-150405") }

// ReviewOutput — reviewOutput(project, shots, now): plan/batches/review-<планы>-<время>/review.mp4;
// для больше чем трёх планов в имени первый и последний. build_review принимает выход только
// в plan/batches и существующий результат не перезаписывает.
func ReviewOutput(project string, shots []string, now string) string {
	name := strings.Join(shots, "-")
	if len(shots) > 3 {
		name = shots[0] + "-" + shots[len(shots)-1]
	}
	return filepath.Join(project, "plan", "batches", "review-"+name+"-"+now, "review.mp4")
}

// reviews — задания сборки по абсолютному пути MP4: удаление пробы, которая ещё собирается,
// запрещено. Владелец — Service; доступ под mu (вызовы Wails идут параллельно).
type reviews struct {
	mu   sync.Mutex
	jobs map[string]string
}

// BuildReview — checks.buildReview(project, options): задание «Проба M01 M02 …» с шагом
// build_review --shots … --output <новая папка> [--plan-only]. Пустой набор и неверные коды —
// ошибка вызова без задания.
func (s *Service) BuildReview(project string, options ReviewOptions) (jobs.Info, error) {
	shots := []string{}
	for _, shot := range options.Shots {
		if trimmed := jscompat.Trim(shot); trimmed != "" {
			shots = append(shots, trimmed)
		}
	}
	if len(shots) == 0 {
		return jobs.Info{}, errors.New(textReviewShotsRequired)
	}
	bad := []string{}
	for _, shot := range shots {
		if !shotID.MatchString(shot) {
			bad = append(bad, shot)
		}
	}
	if len(bad) > 0 {
		return jobs.Info{}, errors.New(textInvalidReviewShots(bad))
	}
	output := ReviewOutput(project, shots, stamp())
	args := append(append([]string{"--shots"}, shots...), "--output", output)
	label := textBuildReviewStep
	if options.PlanOnly {
		args = append(args, "--plan-only")
		label = textCheckReviewStep
	}
	step := jobs.Step{
		Tool: "build_review", Label: label, Args: args,
		Run: func(ctx context.Context, journal *jobs.StepContext) error {
			result, err := tools.RunContext(ctx, project, "build_review", args)
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
			message := jsTrim(result.Stderr)
			if message == "" {
				message = jsTrim(result.Stdout)
			}
			return &jobs.StepError{Code: *result.Code, Message: message}
		},
	}
	info, err := s.jobs.Start(jobs.Spec{Kind: jobs.KindReview, Title: textReviewJobTitle(shots, options.PlanOnly), Project: project, Steps: []jobs.Step{step}})
	if err != nil {
		return jobs.Info{}, err
	}
	s.reviews.mu.Lock()
	s.reviews.jobs[jscompat.Resolve(output)] = info.ID
	s.reviews.mu.Unlock()
	return info, nil
}

// RemoveReview — checks.removeReview(project, path): MP4 пробы и одноимённый рецепт найденной
// пробы удаляются безвозвратно, как unlinkSync оригинала; соседние файлы папки сохраняются,
// опустевшая папка удаляется. Путь — обычный файл plan/batches/<папка>/<файл> без ссылок.
func (s *Service) RemoveReview(project, path string) error {
	video, err := builtoutput.Checked(project, path, builtoutput.File)
	if err != nil {
		return err
	}
	s.reviews.mu.Lock()
	id := s.reviews.jobs[video]
	s.reviews.mu.Unlock()
	if info, ok := s.jobs.Get(id); ok && info.Status == jobs.StatusRunning {
		return errors.New(textReviewStillBuilding)
	}
	list, err := ListReviews(project)
	if err != nil {
		return err
	}
	index := slices.IndexFunc(list, func(item ReviewInfo) bool { return jscompat.Resolve(item.Video) == video })
	if index < 0 {
		return errors.New(textReviewNotFound)
	}
	manifest, err := builtoutput.Checked(project, list[index].Manifest, builtoutput.File)
	if err != nil {
		return err
	}
	// Шлюз записи Go-версии: незавершённая многофайловая операция проекта запрещает удаление.
	if err := projectfs.CheckWrite(project); err != nil {
		return err
	}
	for _, file := range []string{video, manifest} {
		if err := os.Remove(file); err != nil {
			return jscompat.FsError("unlink", file, err)
		}
	}
	// Пустой каталог пробы мешает check_workspace; папки с соседними результатами и рабочими
	// материалами сохраняются.
	directory := filepath.Dir(video)
	entries, err := jscompat.ReadDir(directory)
	if err != nil {
		return err
	}
	if len(entries) == 0 {
		if err := os.Remove(directory); err != nil {
			return jscompat.FsError("rmdir", directory, err)
		}
	}
	return nil
}

// ListReviews — listReviews(project): пробы в папках plan/batches — MP4 рядом с одноимённым JSON,
// в котором video_sha256 — строка, а shots — список (рецепт build_review). Новые первыми. Нет
// plan/batches — пустой список.
func ListReviews(project string) ([]ReviewInfo, error) {
	folder := filepath.Join(project, "plan", "batches")
	result := []ReviewInfo{}
	if !jscompat.Exists(folder) {
		return result, nil
	}
	entries, err := jscompat.ReadDir(folder)
	if err != nil {
		return nil, err
	}
	for _, entry := range entries {
		if !entry.IsDir() {
			continue
		}
		dir := filepath.Join(folder, entry.Name())
		files, err := jscompat.ReadDir(dir)
		if err != nil {
			return nil, err
		}
		for _, file := range files {
			name := file.Name()
			if !strings.HasSuffix(name, ".json") {
				continue
			}
			video := filepath.Join(dir, strings.TrimSuffix(name, ".json")+".mp4")
			if !jscompat.Exists(video) {
				continue
			}
			data, ok := jscompat.ReadJSONFile(filepath.Join(dir, name))
			shots, isList := jscompat.AsArray(jscompat.Get(data, "shots"))
			_, isString := jscompat.Get(data, "video_sha256").(string)
			if !ok || !jscompat.Truthy(data) || !isString || !isList {
				continue
			}
			ids := []string{}
			for _, shot := range shots {
				id, err := jscompat.Prop(shot, "id")
				if err != nil {
					return nil, err
				}
				ids = append(ids, jscompat.ToString(jscompat.Coalesce(id, "")))
			}
			info, err := os.Stat(video)
			if err != nil {
				return nil, jscompat.FsError("stat", video, err)
			}
			total := jscompat.ToNumber(jscompat.Coalesce(jscompat.Get(data, "total_frames"), 0.0))
			// NaN и бесконечность JSON Wails не передаёт; такой рецепт показывается с нулём кадров.
			if math.IsNaN(total) || math.IsInf(total, 0) {
				total = 0
			}
			result = append(result, ReviewInfo{
				Dir: dir, Video: video, Manifest: filepath.Join(dir, name), Shots: ids, TotalFrames: total,
				CreatedAt: info.ModTime().UTC().Format("2006-01-02T15:04:05.000Z"),
			})
		}
	}
	// Оригинал сортирует компаратором `a < b ? 1 : -1`, который у равных времён всегда отвечает
	// «первый аргумент раньше»; TimSort V8 передаёт первым элемент с правой позиции, поэтому
	// пробы с одинаковым временем идут в обратном порядке обхода. Здесь тот же итог задан явно:
	// разворот, затем устойчивая сортировка по убыванию строки времени (не зависит от алгоритма).
	slices.Reverse(result)
	slices.SortStableFunc(result, func(a, b ReviewInfo) int { return strings.Compare(b.CreatedAt, a.CreatedAt) })
	return result, nil
}
