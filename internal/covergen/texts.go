package covergen

import (
	"strings"

	"songframe-go/internal/mediaproviders"
)

// texts — сообщения генерации по назначению. Обложка берёт sourcesTexts.main, референс —
// те же тексты, где часть заменена referenceGenerationMessages: назначение меняет только сообщения,
// проверки, цены и токены согласования общие. TestTextsMatchFrontend сверяет строки со словарями.
type texts struct {
	generationStopped, taskTitle, pathMissing, resultInvalid                  string
	applicationStopping, projectRequired, projectMissing, projectPlanMissing  string
	promptInvalid, busy, alreadyAccepted, requestPrepareFailed, prepareFailed string
	acceptedNeedsNewSession, requestRequired, promptConfirmationRequired      string
	providerChanged, notReady, cropInvalid, cropSaveFailed, sessionClosed     string
	fileInvalid, imageReadFailed, fileReadFailed, preparationStopped          string
	stoppedBeforeSubmit, resolutionConflict, attemptUsed, priceUnconfirmed    string
	priceChanged, submitActionRequired, submitFailed, watchFailed             string
	adapterMissing, costBlocked, stoppedAfterSubmit, seriesUnsupported        func(string) string
	providerRequired, priceFailed, singleImageRequired                        func(string) string
}

// coverTexts — sourcesTexts.main.
var coverTexts = texts{
	generationStopped:          "Генерация обложки остановлена.",
	taskTitle:                  "Обложка проекта",
	pathMissing:                "Агент не вернул путь к созданной обложке.",
	resultInvalid:              "Агент вернул неверный результат обложки. Ожидается JSON с одним полем path.",
	applicationStopping:        "Приложение завершает работу.",
	projectRequired:            "Выберите папку проекта.",
	projectMissing:             "Папка проекта не найдена. Выберите её заново.",
	projectPlanMissing:         "В папке нет plan/project.json.",
	promptInvalid:              "Введите описание обложки длиной не более 32 КБ.",
	busy:                       "Дождитесь завершения подготовки или генерации обложки.",
	alreadyAccepted:            "Обложка уже выбрана.",
	requestPrepareFailed:       "Не удалось подготовить запрос обложки.",
	prepareFailed:              "Не удалось подготовить генерацию обложки.",
	acceptedNeedsNewSession:    "Обложка уже выбрана. Откройте новую сессию для другой обложки.",
	requestRequired:            "Сначала подготовьте и проверьте новый запрос обложки.",
	promptConfirmationRequired: "Подтвердите показанный промпт для текущей попытки генерации обложки.",
	providerChanged:            "Провайдер изображений изменился. Подготовьте новый запрос обложки.",
	notReady:                   "Сначала дождитесь готовой обложки.",
	cropInvalid:                "Выберите квадратную область внутри изображения с целыми координатами.",
	cropSaveFailed:             "Не удалось сохранить квадратную обложку в PNG.",
	sessionClosed:              "Сессия обложки закрыта. Откройте генерацию заново.",
	fileInvalid:                "Нужен настоящий PNG, JPEG или WebP внутри временной папки обложки без символических ссылок.",
	imageReadFailed:            "Не удалось прочитать созданное изображение обложки.",
	fileReadFailed:             "Не удалось прочитать файл обложки. Создайте изображение заново.",
	preparationStopped:         "Подготовка обложки остановлена.",
	stoppedBeforeSubmit:        "Подготовка или генерация обложки остановлена. Отправка не выполнялась.",
	resolutionConflict:         "Разрешение обложки конфликтует с явной настройкой generation.image.resolution.",
	attemptUsed:                "Эта попытка уже запускалась. Для новой генерации подготовьте и подтвердите новый запрос.",
	priceUnconfirmed:           "Стоимость или остаток не подтверждены. Подготовьте запрос и подтвердите цену либо согласие на неизвестную стоимость.",
	priceChanged:               "Стоимость или остаток изменились. Подготовьте запрос и подтвердите цену заново; отправка не выполнялась.",
	submitActionRequired:       "Ожидалась единственная отправка подготовленного запроса.",
	submitFailed:               "Не удалось отправить обложку. Повторная отправка этой попытки запрещена.",
	watchFailed:                "Обложка ещё не получена. Запрос мог быть оплачен; повторная отправка не выполнялась.",
	adapterMissing: func(title string) string {
		return "Для провайдера " + title + " не подключён исполнитель обложки."
	},
	costBlocked: func(title string) string {
		return "Стоимость или баланс " + title + " не позволяют отправить этот запрос."
	},
	stoppedAfterSubmit: func(title string) string {
		return "Получение обложки остановлено. Запрос мог быть отправлен в " + title + "; отмена ожидания не возвращает кредиты."
	},
	seriesUnsupported: func(series string) string {
		return "Для обложки нужен обычный режим без серии " + series + "."
	},
	providerRequired: func(title string) string {
		return "Выберите " + title + " для изображений в настройках проекта."
	},
	priceFailed: func(title string) string {
		return "Не удалось получить стоимость и остаток кредитов " + title + "."
	},
	singleImageRequired: func(title string) string {
		return title + " должен вернуть ровно одно изображение обложки."
	},
}

// referenceTexts — sourcesTexts.main, дополненные referenceGenerationMessages.
var referenceTexts = func() texts {
	result := coverTexts
	result.generationStopped = "Генерация референса остановлена."
	result.taskTitle = "Изображение референса проекта"
	result.pathMissing = "Агент не вернул путь к созданному референсу."
	result.resultInvalid = "Агент вернул неверный результат референса. Ожидается JSON с одним полем path."
	result.promptInvalid = "Введите описание изображения длиной не более 32 КБ."
	result.busy = "Дождитесь завершения подготовки или генерации изображения."
	result.alreadyAccepted = "Изображение уже выбрано."
	result.requestPrepareFailed = "Не удалось подготовить запрос изображения."
	result.prepareFailed = "Не удалось подготовить генерацию изображения."
	result.acceptedNeedsNewSession = "Изображение уже выбрано. Откройте новую сессию для другого изображения."
	result.requestRequired = "Сначала подготовьте и проверьте новый запрос изображения."
	result.promptConfirmationRequired = "Подтвердите показанный промпт для текущей попытки генерации изображения."
	result.providerChanged = "Провайдер изображений изменился. Подготовьте новый запрос изображения."
	result.sessionClosed = "Сессия изображения закрыта. Откройте генерацию заново."
	result.fileInvalid = "Нужен настоящий PNG, JPEG или WebP внутри папки попытки без символических ссылок."
	result.imageReadFailed = "Не удалось прочитать созданное изображение референса."
	result.fileReadFailed = "Не удалось прочитать файл референса. Создайте изображение заново."
	result.preparationStopped = "Подготовка изображения остановлена."
	result.stoppedBeforeSubmit = "Подготовка или генерация изображения остановлена. Отправка не выполнялась."
	result.resolutionConflict = "Разрешение изображения конфликтует с явной настройкой generation.image.resolution."
	result.submitFailed = "Не удалось отправить изображение. Повторная отправка этой попытки запрещена."
	result.watchFailed = "Изображение ещё не получено. Запрос мог быть оплачен; повторная отправка не выполнялась."
	result.adapterMissing = func(title string) string {
		return "Для провайдера " + title + " не подключён исполнитель изображения."
	}
	result.seriesUnsupported = func(series string) string {
		return "Для референса нужен обычный режим без серии " + series + "."
	}
	result.singleImageRequired = func(title string) string {
		return title + " должен вернуть ровно одно изображение референса."
	}
	return result
}()

// textsFor — тексты назначения: PurposeReference или обложка.
func textsFor(reference bool) texts {
	if reference {
		return referenceTexts
	}
	return coverTexts
}

// Тексты сохранения архива и приёмки референса (referenceImageTexts).
const (
	textArchiveFailed     = "Не удалось сохранить сведения о попытке. Оригиналы остаются в архиве проекта; проверьте доступность папки и свободное место."
	textReferenceNotReady = "Сначала получите готовое изображение референса."
)

// imageProviderRequired — sourcesTexts.main.imageProviderRequired с названиями провайдеров
// изображений реестра через « или » (mediaProviderTitles('image')); общий для обоих назначений.
func imageProviderRequired() string {
	titles := []string{}
	for _, id := range mediaproviders.IDs() {
		if mediaproviders.Supports(id, mediaproviders.Image) {
			info, _ := mediaproviders.Lookup(id)
			titles = append(titles, info.Title)
		}
	}
	return "Выберите поддерживаемого провайдера изображений в настройках проекта: " + strings.Join(titles, " или ") + "."
}
