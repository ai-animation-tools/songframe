package production

import (
	"context"
	"errors"

	"songframe-go/internal/jscompat"
	"songframe-go/internal/mediaproviders"
	"songframe-go/internal/projectfile"
)

// RequirePackageAccess — requireProductionPackageAccess оригинала: общая проверка доступа к
// сохранённому запросу перед оценкой, отправкой и получением результата. В пакете должен быть
// запрос с провайдером; require проверяет явный выбор и вход провайдера вида медиа запроса; выбор
// проекта должен совпадать с провайдером запроса без учёта регистра и крайних пробелов — другой
// провайдер требует нового запроса.
func RequirePackageAccess(ctx context.Context, project, packageDir string, require func(ctx context.Context, project, kind string) error) error {
	view, err := ReadPackage(project, packageDir)
	if err != nil {
		return err
	}
	if view == nil || view.Request == nil {
		return errors.New(textSavedRequestRequired)
	}
	request := view.Request
	if request.Provider == nil || *request.Provider == "" {
		return errors.New(textRequestProviderMissing)
	}
	kind := mediaproviders.Video
	if request.Kind == "image" {
		kind = mediaproviders.Image
	}
	if err := require(ctx, project, kind); err != nil {
		return err
	}
	settings, err := projectfile.ReadSettings(project)
	if err != nil {
		return err
	}
	generation, _ := jscompat.Parse(settings.Generation)
	selected, _ := jscompat.GetPath(generation, kind, "provider").(string)
	if !sameProvider(selected, *request.Provider) {
		return errors.New(textMediaProviderChanged)
	}
	return nil
}
