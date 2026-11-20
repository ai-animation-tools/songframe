package schemes

// View — ответ schemes.view для страницы «Схемы»: документ, локации кастинга и проблемы.
// Ничего не пишет.
type View struct {
	Document Document `json:"document"`
	// Missing — plan/schemes.json ещё нет: схем нет, первая запись создаст файл.
	Missing bool `json:"missing"`
	// Damaged — файл не разбирается; запись запрещена, пока его не исправят.
	Damaged bool `json:"damaged"`
	// Locations — локации кастинга, к которым можно привязать схемы.
	Locations []Location `json:"locations"`
	// Entities — сущности кастинга, с которыми можно связать объект схемы (без мира сцены).
	Entities []Entity `json:"entities"`
	// Problems — проблемы документа.
	Problems []string `json:"problems"`
	// WithoutScheme — ID локаций без схемы: страница отмечает их в списке, а не перечисляет
	// проблемами — у нового клипа их много, и это обычное состояние работы.
	WithoutScheme []string `json:"withoutScheme"`
}

// ViewProject — схемы проекта для страницы. Повреждённый файл даёт Damaged и проблему,
// остальное — проблемы проверки и локации кастинга без схемы.
func ViewProject(project string) (View, error) {
	catalog := LoadCatalog(project)
	view := View{Document: Empty(), Locations: catalog.Locations, Entities: catalog.Linkable, Problems: []string{}, WithoutScheme: []string{}}
	document, missing, err := Read(project)
	if err == errDamaged {
		view.Damaged = true
		view.Problems = append(view.Problems, textFileDamaged)
		return view, nil
	}
	if err != nil {
		return View{}, err
	}
	view.Document, view.Missing = document, missing
	view.Problems = append(view.Problems, Validate(document, catalog)...)
	for _, location := range catalog.Locations {
		if !hasScheme(document, location.ID) {
			view.WithoutScheme = append(view.WithoutScheme, location.ID)
		}
	}
	return view, nil
}

// hasScheme — у локации есть схема.
func hasScheme(document Document, location string) bool {
	for _, scheme := range document.Schemes {
		if scheme.Location == location {
			return true
		}
	}
	return false
}
