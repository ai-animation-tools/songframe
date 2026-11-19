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
	// Problems — проблемы документа.
	Problems []string `json:"problems"`
	// WithoutTop — ID локаций без обязательного вида сверху: страница отмечает их в списке,
	// а не перечисляет проблемами — у нового клипа их много, и это обычное состояние работы.
	WithoutTop []string `json:"withoutTop"`
}

// ViewProject — схемы проекта для страницы. Повреждённый файл даёт Damaged и проблему,
// остальное — проблемы проверки и локации кастинга без вида сверху.
func ViewProject(project string) (View, error) {
	catalog := LoadCatalog(project)
	view := View{Document: Empty(), Locations: catalog.Locations, Problems: []string{}, WithoutTop: []string{}}
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
		if !hasView(document, location.ID, ViewTop) {
			view.WithoutTop = append(view.WithoutTop, location.ID)
		}
	}
	return view, nil
}

// hasView — у локации есть схема данного вида.
func hasView(document Document, location, kind string) bool {
	for _, scheme := range document.Schemes {
		if scheme.Location == location && scheme.View == kind {
			return true
		}
	}
	return false
}
