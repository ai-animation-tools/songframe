package productionworkflow

import (
	"strings"

	"songframe-go/internal/jscompat"
)

// Тексты создания и импорта опор (этап 45g.3) дословно из оригинала на 634fd94:
// productionTexts.main.workflow (generateFrames), main.images (keyframe-images.ts), main.imageRequest
// (frame-image-request.ts) и applicationTexts (маршруты ipc.ts). Уходят в ошибки Wails и в записи
// предложений, поэтому меняются только вместе с поведением.
const (
	textAllFramesCreated = "Все опоры уже созданы."

	textFrameDescriptionsRequired = "Сначала подготовьте описания опор."
	textImagesJobIncomplete       = "Задание опор не завершено успешно."
	textImagesJobRequestMismatch  = "Задание опор относится к другому согласованному запросу."
	textImagesJobRecordCorrupt    = "Повреждена запись задания опор."
	textImagesReferencesChanged   = "Референсы изменились: подготовьте опоры заново."
	textImagesResultInvalid       = "Неверный контракт результата опор."
	textImagesFrameEntryInvalid   = "Неверная запись опоры."
	textImagesFramePathInvalid    = "Неверный путь опоры."
	textImagesWorkDirUnavailable  = "Рабочая папка опор недоступна. Подготовьте новое задание."
	textImagesRequestHashCorrupt  = "Повреждён SHA запроса опор."

	textOneFrameRequired = "Один платный запрос подготавливается для одной опоры."

	textImageJobKindInvalid = "Исполнитель вернул неверный тип задания опор."
	textImageJobMissing     = "Задание изображений не создано."
	// textImageExecutorMissing — applicationTexts.imageExecutorMissing: проход создан без слоя
	// провайдеров медиа.
	textImageExecutorMissing = "Нет исполнителя опор для программы-агента этого задания."
	textImageConsentFailed   = "Не удалось записать согласование изображения."
	// TextActualImagesRequired — applicationTexts.actualImagesRequired: маршрут importFrames получил не
	// изображения (нет файла, ссылка, не PNG/JPEG/WebP, не декодируется).
	TextActualImagesRequired = "Выберите настоящие изображения PNG, JPG или WebP."

	// generationProviderFallback — providerTexts.generationProvider: подпись неизвестного провайдера.
	generationProviderFallback = "провайдер генерации"
	// framesCorrectionsLabel — исправления пользователя в замороженном промпте платной опоры: входят
	// в SHA запроса и подтверждаются вместе с ценой.
	framesCorrectionsLabel = "\n\nИсправления к прежним вариантам: "
)

func textAcceptFrameFirst(frame any) string {
	return "Сначала утвердите опору " + jscompat.ToString(frame) + " или отправьте её на доработку."
}

func textImageProviderRequired(providers string) string {
	return "Выберите провайдера генерации изображений в настройках проекта: " + providers + "."
}

func textImageAdapterMissing(provider string) string {
	return "Исполнитель изображений " + provider + " не подключён."
}

func textReferenceUnavailable(path string) string {
	return "Недоступен референс опоры: " + path
}

func textApprovedFrameUnavailable(frame string) string {
	return "Недоступна утверждённая опора " + frame + "."
}

func textImagesJobTitle(shot, frames, provider string) string {
	return "Опоры " + shot + ": " + frames + " · " + provider
}

func textImagesFileListMissing(provider string) string {
	return provider + " не вернул список файлов опор."
}

func textImagesFrameImageRequired(frame string) string {
	return "Опора " + frame + ": нужен настоящий файл изображения в папке кандидатов."
}

func textImagesFrameExtensionMismatch(frame string) string {
	return "Опора " + frame + ": расширение не соответствует фактическому формату изображения. Исходный файл сохранён."
}

func textImagesFramesIncomplete(provider string) string {
	return provider + " вернул не все согласованные опоры."
}

func textImageProviderMismatch(provider string) string {
	return "Выберите " + provider + " для изображений в настройках проекта."
}

func textSeriesUnsupported(series string) string {
	return "Для одной опоры выберите обычный режим без серии " + series + "."
}

func textChoosePaidImageProvider(titles []string) string {
	joined := strings.Join(titles, " или ")
	if joined == "" {
		joined = "платного провайдера"
	}
	return "Выберите " + joined + " для изображений в настройках проекта."
}

// textImagesPrompt — промпт задания опор провайдера-агента (KeyframeImages.start оригинала):
// инструкция и формат ответа генератора; абзацы об утверждённых кадрах и замечаниях — только при
// их наличии.
func textImagesPrompt(approved, notes bool) string {
	prompt := "Создай перечисленные опорные изображения встроенным инструментом генерации изображений. Используй только переданные копии референсов. "
	if approved {
		prompt += "approvedFrames — уже утверждённые кадры этого же плана: передай их генератору как референсы и сохрани с ними внешность и одежду героев, свет, место, " +
			"расстановку и направление транспорта и героев; меняй только то, что задаёт промпт создаваемой опоры. "
	}
	if notes {
		prompt += "notes — исправления пользователя к прежним вариантам: выполни их, они важнее совпадения с прежним результатом. "
	}
	return prompt +
		"Сохрани каждый результат как Kxx.png, Kxx.jpg или Kxx.webp в текущей папке, сохраняя фактический формат генератора. Не используй внешние сервисы генерации, API-ключи или другие генераторы. " +
		"Если встроенный image tool недоступен, сообщи об этом и не подменяй его другим способом. " +
		"Не изменяй референсы, исходный проект или принятые материалы. " +
		`Финальный ответ — один JSON без Markdown: {"schemaVersion":1,"stage":"frames","images":[{"id":"K01","path":"K01.png"}]}.`
}
