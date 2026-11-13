package components

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
)

// PackageCheckRequest задаёт отдельный чистый каталог состояния и полный офлайн-комплект smoke-проверки.
// LocalFiles содержит готовую программу ffmpeg либо его архив, архив ort-cpu и файлы ctc-ru/ctc-vocab.
// Рядом с готовым ffmpeg нужен ffprobe; исходники только читаются, внешняя пара не копируется.
type PackageCheckRequest struct {
	ProfileDirectory string            `json:"profileDirectory"`
	LocalFiles       map[string]string `json:"localFiles"`
}

// PackageCheckReport сохраняет установку и функциональные статусы для проверки готовой поставки.
// Ready означает успешный CPU inference CTC и пригодность его зависимостей, а не полную разметку песни.
type PackageCheckReport struct {
	Status       string          `json:"status"`
	Error        string          `json:"error,omitempty"`
	Installation InstallSnapshot `json:"installation"`
	Snapshot     Snapshot        `json:"snapshot"`
}

// PackageCheck устанавливает компоненты тем же Manager, которым пользуется приложение, и проверяет CTC.
// Отдельный каталог состояния исключает пользовательские настройки; полный набор LocalFiles исключает скачивание.
// Check запускает существующий CPU probe: секунду синтетического звука, проверку logits и FFmpeg recipes.
// Профиль остаётся после успеха или отказа для осмотра отчёта; удалением владеет вызывающий smoke-сценарий.
// Вызывать следует в отдельном процессе до иных ORT-проверок: binding закрепляет первую загруженную библиотеку.
func PackageCheck(ctx context.Context, request PackageCheckRequest) (PackageCheckReport, error) {
	return packageCheck(ctx, request, NewManager)
}

// packageCheck подменяет в тестах только создание менеджера; установка и обработка статусов остаются реальными.
// До создания профиля проверяется полный локальный ввод, чтобы ошибка пути не затронула существующий профиль.
func packageCheck(ctx context.Context, request PackageCheckRequest, createManager func(string) (*Manager, error)) (report PackageCheckReport, resultErr error) {
	report.Status = "error"
	defer func() {
		if resultErr != nil {
			report.Error = resultErr.Error()
			if ctx.Err() != nil {
				report.Status = "cancelled"
			}
		}
	}()
	if err := ctx.Err(); err != nil {
		return report, err
	}
	if !filepath.IsAbs(request.ProfileDirectory) {
		return report, fmt.Errorf("smoke: нужен абсолютный путь отдельного каталога состояния")
	}
	ids := []string{"ffmpeg", "ort-cpu", "ctc-ru", "ctc-vocab"}
	if len(request.LocalFiles) != len(ids) {
		return report, fmt.Errorf("smoke: нужны ровно четыре офлайн-источника: ffmpeg, ort-cpu, ctc-ru, ctc-vocab")
	}
	for _, id := range ids {
		name := request.LocalFiles[id]
		if !filepath.IsAbs(name) {
			return report, fmt.Errorf("smoke %s: нужен абсолютный путь офлайн-файла", id)
		}
		info, err := os.Stat(name)
		if err != nil {
			return report, fmt.Errorf("smoke %s: офлайн-файл недоступен: %w", id, err)
		}
		if !info.Mode().IsRegular() {
			return report, fmt.Errorf("smoke %s: источник должен быть обычным файлом", id)
		}
	}
	// Mkdir намеренно отклоняет даже пустую существующую папку: smoke не получает
	// права читать либо менять профиль, созданный вне текущего проверочного запуска.
	if err := os.Mkdir(request.ProfileDirectory, 0700); err != nil {
		return report, fmt.Errorf("smoke: не удалось создать новый изолированный профиль: %w", err)
	}
	m, err := createManager(request.ProfileDirectory)
	if err != nil {
		return report, err
	}
	// Проверка использует только переданные файлы: явную готовую пару либо managed payload.
	// PATH не участвует даже при повреждённом FFmpeg: системная пара не должна скрыть дефект поставки.
	m.options.lookPath = func(string) (string, error) { return "", os.ErrNotExist }
	localFiles := request.LocalFiles
	archive, err := isComponentArchive(localFiles["ffmpeg"])
	if err != nil {
		return report, fmt.Errorf("smoke: чтение источника FFmpeg: %w", err)
	}
	if !archive {
		// Готовая пара уже могла пройти проверку поставки. Подключаем её тем же API, что UI,
		// не распаковывая большой XZ заново; итоговый Check всё равно выполняет реальные recipes.
		report.Snapshot, err = m.Connect(ctx, "ffmpeg", localFiles["ffmpeg"])
		if err != nil {
			return report, fmt.Errorf("smoke: подключение готового FFmpeg: %w", err)
		}
		ids = ids[1:]
		localFiles = map[string]string{}
		for _, id := range ids {
			localFiles[id] = request.LocalFiles[id]
		}
	}
	report.Installation, err = m.Install(ctx, InstallRequest{Components: ids, LocalFiles: localFiles})
	if err != nil {
		report.Snapshot = m.State()
		return report, fmt.Errorf("smoke: установка компонентов: %w", err)
	}
	report.Snapshot, err = m.Check(ctx, []string{"ctc-existing-vocals"}, true)
	if err != nil {
		return report, fmt.Errorf("smoke: проверка компонентов: %w", err)
	}
	// Отказ отдельного ONNX-графа хранится в Snapshot и не обязан стать общей ошибкой Check.
	// Поэтому успешного возврата недостаточно: принимается только ready всей выбранной операции.
	for _, operation := range report.Snapshot.Operations {
		if operation.ID != "ctc-existing-vocals" {
			continue
		}
		if operation.Status != "ready" {
			return report, fmt.Errorf("smoke: CTC не готов: %s", operation.Reason)
		}
		report.Status = "ready"
		return report, nil
	}
	return report, fmt.Errorf("smoke: отсутствует операция ctc-existing-vocals")
}
