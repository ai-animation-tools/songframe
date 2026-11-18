package scenarioworkflow

import (
	"crypto/sha256"
	"encoding/hex"
	"fmt"
	"os"
	"path/filepath"

	"songframe/internal/dynvalue"
	"songframe/internal/mediafile"
	"songframe/internal/sources"
)

// Изображения кастинга для проверки сценария. Агент сверяет образ и начальное состояние с
// картинками, поэтому они прикладываются к сообщению, а не передаются путями. Оригиналы бывают по
// несколько мегабайт, а бюджет вложений у CLI агента ограничен (docs/agent-image-limits.md), поэтому
// приложение готовит уменьшенные JPEG-копии в каталоге состояния и прикладывает их, пока хватает
// бюджета: сначала первое изображение каждой сущности, затем остальные. Неприложенное изображение
// остаётся в списке castImages с attached=false, чтобы агент не судил о нём.

const (
	// checkImageSide — наибольшая сторона копии: деталей одежды и внешности достаточно, а копия
	// занимает около 50–100 КБ.
	checkImageSide = 768
	// checkImageQuality — качество JPEG копии.
	checkImageQuality = 80
	// checkImagesMax — наибольшее число вложений (у менеджера агентов предел 64).
	checkImagesMax = 60
	// checkImageFileMax — наибольший размер одной копии (у менеджера агентов предел 5 МиБ).
	checkImageFileMax = 5 * 1024 * 1024
	// DefaultCheckImageBudget — бюджет вложений, если выбранный агент неизвестен: меньший из
	// бюджетов агентов (Claude), чтобы задание не отклонялось.
	DefaultCheckImageBudget = 6 * 1024 * 1024
)

// checkImage — изображение кастинга в контексте проверки. id связывает запись списка с файлом
// вложения, label — то, как изображение видит человек в карточке кастинга: им агент называет
// изображение в отчёте.
type checkImage struct {
	id, entity, name, path, label, note string
	file                                string // путь копии; пусто — не приложено
}

// castImageList — изображения сущностей кастинга в порядке вложения: первые изображения всех
// сущностей, затем остальные по порядку. ID I01… — номер в этом порядке. Подпись и заметка — из
// описи исходников (sources.ManifestFiles), как на чипе изображения в карточке кастинга; изображение
// вне описи подписано именем сущности и номером в её карточке.
func castImageList(castValue, manifest any) []checkImage {
	type entry struct{ entity, name, path, label, note string }
	described := sources.ManifestFiles(manifest)
	rounds := [][]entry{}
	for _, entity := range arrayItems(dynvalue.Get(castValue, "entities")) {
		id := dynvalue.ToString(dynvalue.Get(entity, "id"))
		name := dynvalue.ToString(dynvalue.Get(entity, "name"))
		for index, item := range arrayItems(dynvalue.Get(entity, "images")) {
			for len(rounds) <= index {
				rounds = append(rounds, nil)
			}
			path := dynvalue.ToString(item)
			info, ok := described[path]
			if !ok {
				info.Label = fmt.Sprintf("%s · изображение %d", name, index+1)
			}
			rounds[index] = append(rounds[index], entry{id, name, path, info.Label, info.Note})
		}
	}
	result := []checkImage{}
	for _, round := range rounds {
		for _, item := range round {
			result = append(result, checkImage{id: fmt.Sprintf("I%02d", len(result)+1), entity: item.entity, name: item.name, path: item.path, label: item.label, note: item.note})
		}
	}
	return result
}

// checkImagesDir — папка копий проекта в каталоге состояния; одна на проект, очищается перед
// подготовкой: проверка сценария у проекта одна.
func (w *Workflow) checkImagesDir(project string) (string, error) {
	base := w.options.LocalDir
	if base == "" {
		base = os.TempDir()
	}
	sum := sha256.Sum256([]byte(project))
	directory := filepath.Join(base, "scenario-check", hex.EncodeToString(sum[:8]))
	if err := os.RemoveAll(directory); err != nil {
		return "", err
	}
	return directory, os.MkdirAll(directory, 0o777)
}

// prepareCheckImages — копии изображений в пределах budget байт. Возвращает список с заполненным
// file у приложенных и проблему для агента: изображение не читается или бюджета не хватило. Ошибка
// — только сбой каталога состояния.
func (w *Workflow) prepareCheckImages(project string, images []checkImage, budget int) ([]checkImage, string, error) {
	if len(images) == 0 {
		return images, "", nil
	}
	directory, err := w.checkImagesDir(project)
	if err != nil {
		return nil, "", err
	}
	used, count := 0, 0
	unreadable, skipped := []string{}, 0
	for index := range images {
		item := &images[index]
		if count >= checkImagesMax {
			skipped++
			continue
		}
		payload, err := shrinkImage(filepath.Join(project, "source", filepath.FromSlash(item.path)))
		if err != nil {
			unreadable = append(unreadable, item.path)
			continue
		}
		if len(payload) > checkImageFileMax || used+len(payload) > budget {
			skipped++
			continue
		}
		target := filepath.Join(directory, item.id+".jpg")
		if err := os.WriteFile(target, payload, 0o666); err != nil {
			return nil, "", err
		}
		item.file = target
		used += len(payload)
		count++
	}
	return images, textCheckImagesProblem(unreadable, skipped), nil
}

// shrinkImage — JPEG-копия изображения, вписанная в checkImageSide без увеличения.
func shrinkImage(path string) ([]byte, error) {
	return mediafile.ShrinkJPEG(path, checkImageSide, checkImageQuality)
}
