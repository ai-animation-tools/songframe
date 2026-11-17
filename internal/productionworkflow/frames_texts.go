package productionworkflow

import (
	"strings"

	"songframe/internal/dynvalue"
)

// Тексты создания и импорта опор: проверок генерации, задания опор провайдера-агента, платного
// запроса изображения и входа импорта. Уходят в ошибки Wails и в записи предложений и
// зафиксированы эталоном testdata/golden/production-frames, поэтому меняются только вместе с
// поведением.
const (
	textAllFramesCreated = "Все опоры уже созданы."

	textFrameDescriptionsRequired = "Сначала подготовьте описания опор."
	textImagesJobIncomplete       = "Задание опор не завершено успешно."
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
	// TextActualImagesRequired — импорт опор (ImportFrames) получил не
	// изображения (нет файла, ссылка, не PNG/JPEG/WebP, не декодируется).
	TextActualImagesRequired = "Выберите настоящие изображения PNG, JPG или WebP."

	// generationProviderFallback — providerTexts.generationProvider: подпись неизвестного провайдера.
	generationProviderFallback = "провайдер генерации"
	// framesCorrectionsLabel — исправления пользователя в зафиксированном промпте платной опоры: входят
	// в SHA запроса и подтверждаются вместе с ценой.
	framesCorrectionsLabel = "\n\nИсправления к прежним вариантам: "
)

// framesApprovedLabel — пояснение в зафиксированном промпте платной опоры: какие входы запроса —
// уже утверждённые опоры этого плана. Без него модель не отличила бы их от референсов кастинга.
// Входит в SHA запроса, как и исправления.
func framesApprovedLabel(slots []string) string {
	if len(slots) == 1 {
		return "\n\nСогласованность: " + slots[0] + " — уже утверждённая опора этого плана; сохрани с неё внешность героев, одежду, свет и расстановку."
	}
	return "\n\nСогласованность: " + strings.Join(slots, ", ") + " — уже утверждённые опоры этого плана; сохрани с них внешность героев, одежду, свет и расстановку."
}

// textFramePromptMissing — отказ создать опору своего описания без промпта: её загружают своим файлом.
func textFramePromptMissing(frame any) string {
	return "У опоры " + dynvalue.ToString(frame) + " нет промпта: загрузите её своим файлом или добавьте промпт в описании."
}

func textAcceptFrameFirst(frame any) string {
	return "Сначала утвердите опору " + dynvalue.ToString(frame) + " или отправьте её на доработку."
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

// textImagesPrompt — промпт задания опор провайдера-агента:
// инструкция и формат ответа генератора; абзацы об утверждённых кадрах и замечаниях — только при
// их наличии; абзац о кадрах других планов — только если они среди копий.
func textImagesPrompt(approved, notes, shotFrames bool) string {
	prompt := "Создай перечисленные опорные изображения встроенным инструментом генерации изображений. Используй только переданные копии референсов. " +
		"references — что на каждой копии: file — имя копии, entity — ID сущности кастинга, name — её имя, kind — вид (например, character — персонаж, location — место, prop — предмет). " +
		"Когда промпт опоры или notes называют референс по имени (референс «Мастерская»), это копия с таким name; не определяй принадлежность копии по её содержимому. " +
		"Передай генератору все копии из referencePaths создаваемой опоры и в его промпте назови по name, какая копия чья. "
	if shotFrames {
		prompt += "Копия с полем shot — кадр уже принятого плана клипа с этим ID: бери из неё только то, что о ней говорит промпт опоры (место, свет, расположение предметов, позу, одежду); ракурс и крупность задаёт промпт опоры. "
	}
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
