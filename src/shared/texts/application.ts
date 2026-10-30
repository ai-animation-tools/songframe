/** Пользовательские сообщения обвязки IPC; команды, пути и операции остаются в главном процессе. */
export const applicationTexts = {
  desktop: {
    commandTimedOut: 'Системная команда открытия не ответила вовремя.',
    commandMissing: ({ command }: { command: string }) => `Не найдена системная команда ${command}.`,
    commandFailed: 'Системная команда открытия завершилась с ошибкой.',
    pathUnavailable: ({ path }: { path: string }) => `Не удалось открыть «${path}»: файл или папка не найдены либо недоступны.`,
    openFailed: ({ path, reason }: { path: string; reason: string }) => `Не удалось открыть «${path}»: ${reason}`
  },
  projectRecoveryTitle: 'Не удалось восстановить файлы проекта',
  projectRecoveryFailed: ({ reason }: { reason: string }) =>
    `${reason}\n\nРезервные копии сохранены. Текущий проект закрыт: устраните причину перед дальнейшей работой с ним. Можно открыть другой проект.`,
  startupFailedTitle: 'SongFrame: ошибка запуска',
  agentManagerMissing: 'Менеджер агента не создан.',
  scaffoldFailed: ({ details }: { details: string }) => `Не удалось подготовить каркас: ${details}`,
  imageAgentUnsupported: 'Выбранный провайдер изображений не рисует опоры программой-агентом.',
  imageExecutorMissing: 'Нет исполнителя опор для программы-агента этого задания.',
  paidExecutorMissing: 'Для провайдера не подключён исполнитель платного запроса.',
  coverCropFailed: 'Не удалось вырезать выбранную область обложки.',
  coverWindowClosed: 'Окно генерации обложки закрыто.',
  mediaKindUnknown: 'Неизвестный вид медиа.',
  providerUnsupported: 'Провайдер не поддерживается. Сохранённое значение оставлено без изменений.',
  imageJobKindInvalid: 'Исполнитель вернул неверный тип задания опор.',
  imageJobMissing: 'Задание изображений не создано.',
  choosePaidImageProvider: ({ titles }: { titles: readonly string[] }) =>
    `Выберите ${titles.join(' или ') || 'платного провайдера'} для изображений в настройках проекта.`,
  imageConsentFailed: 'Не удалось записать согласование изображения.',
  chooseVideoProvider: ({ titles }: { titles: string }) => `Выберите поддерживаемого провайдера видео: ${titles}.`,
  actualImagesRequired: 'Выберите настоящие изображения PNG, JPG или WebP.',
  packageBusy: 'Для этого пакета уже выполняется задание. Дождитесь завершения.',
  scenarioReviewRequired: 'Кастинг, трактовка или исходники изменились: проверьте и утвердите актуальный сценарий на странице «Сценарий».',
  scenarioReviewFailed: ({ reason }: { reason: string }) => `Не удалось проверить актуальность сценария: ${reason}`,
  packagedResources: 'Готовое приложение использует собственные ресурсы. Выбор checkout доступен только при разработке.',
  sourcesInvalid: ({ path }: { path: string }) => `В папке нет tools/common.py: ${path}`,
  lyricsInvalid: ({ problems }: { problems: readonly string[] }) => `Исправьте текст песни на странице «Исходники»: ${problems.join(' ')}`,
  shotBusy: 'Для этого кадра уже выполняется задание. Дождитесь завершения.',
  speechDuration: ({ min, max }: { min: number; max: number }) => `Провайдер видео принимает звук длиной от ${min} до ${max} с: поправьте границы среза.`,
  saveMontageVideo: 'Сохранить видеопробу',
  jobMissing: 'Задание не найдено в журнале.',
  textFileTooLarge: 'Файл больше 2 МБ: выберите текстовый файл меньшего размера.'
} as const;
