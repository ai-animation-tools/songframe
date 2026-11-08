import { commonTexts } from './common';

/** Общие сообщения медиа: конкретный сервис передаётся названием из реестра, протокол запросов остаётся у адаптера. */
export const mediaTexts = {
  agentImageFramesRequired: commonTexts.generation.frameDescriptionsRequired,
  agentImageReferenceInvalid: 'Референс не является изображением.',
  agentImagePreparationUsed: 'Эта подготовка или подтверждение уже использованы. Для нового запуска подготовьте и подтвердите новый запрос.',
  agentImageRequestChanged: 'Запрос или референсы изменились после согласования.',
  agentImageJobMismatch: 'Неверное задание для согласованного запроса.',
  jsonObjectRequired: 'Ожидается JSON-объект медиа.',
  localFileRequired: 'Нужен локальный файл внутри рабочей папки.',
  invalidArguments: (title: string) => `${title} вернул неверное объявление параметров.`,
  projectOptionConflict: ({ name, value, expected }: { name: string; value: string | undefined; expected: string | undefined }) =>
    `Параметр ${name}=${value} конфликтует с явной настройкой проекта ${expected}.`,
  mixedInputs: (flags: string) => `Не смешивайте именованные входы с короткими флагами ${flags}.`,
  slotRequiresNamedInput: 'slot допустим только для именованного входа input.',
  unknownInputFlag: (flag: string) => `Неизвестный флаг входа ${flag}.`,
  ambiguousInputSlot: (flag: string) => `Нет однозначного объявленного слота для ${flag}; укажите именованные input slots.`,
  unreadableInitialFrame: (path: string) => `Начальный кадр не прочитан как изображение: ${path}`,
  initialFrameRatioMismatch: ({ width, height, expected, name }: { width: number; height: number; expected: unknown; name: string }) =>
    `Начальный кадр ${width}×${height} не совпадает с пропорциями проекта ${expected} (${name}); ролик вышел бы другого формата. Используйте опору с пропорциями ${expected}.`,
  modelNotDeclared: 'Модель не объявлена для выбранной команды.',
  invalidRequest: 'Неверная команда, промпт или число результатов.',
  undeclaredParameter: ({ name, value }: { name: string; value: string | undefined }) =>
    `Параметр ${name}=${value} не объявлен для модели или передаётся отдельно.`,
  duplicateParameter: (name: string) => `Параметр ${name} указан дважды.`,
  outputCountNotDeclared: (outputs: number) => `Модель не объявляет выбор числа результатов outputs=${outputs}.`,
  outputCountMismatch: 'Число outputs отличается от параметра количества изображений.',
  projectParameterMismatch: ({ name, value, expected }: { name: string; value: string | undefined; expected: string | undefined }) =>
    `Параметр ${name}=${value} должен совпадать с настройкой проекта ${expected}.`,
  invalidNamedInput: 'Неверный именованный вход.',
  inputNotDeclared: (name: string) => `Вход ${name} не объявлен для выбранной команды.`,
  inputCountExceeded: (name: string) => `Превышено число входов ${name}.`,
  inputUnavailable: (path: string) => `Вход недоступен: ${path}`,
  requiredSlotMissing: (name: string) => `Не заполнен обязательный слот ${name}.`,
  requiredParameterMissing: (name: string) => `Не заполнен обязательный параметр ${name}.`,
  itemCountExceeded: (name: string) => `Превышено число элементов ${name}.`,
  localInputsRequired: 'Подготовка принимает только локальные входы.',
  unsupportedParameter: ({ name, value, allowed }: { name: string; value: string | undefined; allowed: string }) =>
    `Параметр ${name} имеет неподдерживаемое значение ${value}; допустимо: ${allowed}.`,
  durationMismatch: ({
    duration,
    rule,
    windowSeconds,
    minSeconds,
    supported
  }: {
    duration: string | undefined;
    rule: string;
    windowSeconds: number;
    minSeconds?: number;
    supported?: number[];
  }) =>
    `Длительность duration=${duration} должна быть ближайшей поддерживаемой по правилу ${rule} для окна ${windowSeconds} с${minSeconds ? ` и не короче ${minSeconds} с` : ''}${supported?.length ? `: ${Math.min(...supported)} с` : '; подходящие длительности не объявлены'}.`,
  invalidCombinedLimit: 'Общий лимит модели объявлен в неизвестном формате.',
  combinedLimitExceeded: 'Превышен общий лимит входных материалов модели.',
  capabilitiesUnavailable: (title: string) => `Нет подтверждённых возможностей выбранного медиа ${title}.`,
  commandModelNotDeclared: ({ id, command }: { id: string; command: string }) => `Модель ${id} не объявлена для команды ${command}.`,
  preferredModelCompatible: (id: string) => `Предпочтительная модель ${id} поддерживает все параметры запроса.`,
  preferredModelRejected: ({ preferredModel, failure, id }: { preferredModel: string; failure: string | undefined; id: string }) =>
    `Предпочтительная модель ${preferredModel} не подходит: ${failure} Выбрана совместимая модель ${id}.`,
  automaticModelSelected: ({ id, requested }: { id: string; requested: boolean }) =>
    `Предпочтительная модель не задана. Выбрана совместимая модель ${id}${requested ? ', указанная в запросе' : ''}.`,
  compatibleModelUnavailable: ({ title, command, details }: { title: string; command: string; details: string }) =>
    `Нет совместимой модели ${title} для команды ${command}. ${details || 'Аккаунт не объявляет модели этой команды.'}`,
  invalidModels: (title: string) => `${title} вернул неверное объявление моделей.`,
  invalidModel: (title: string) => `${title} вернул неверное объявление модели.`,
  prepareFailed: (title: string) => `Не удалось подготовить запрос ${title}.`,
  commandModelsMissing: (command: string) => `${command}: модели аккаунта не объявлены.`,
  executorKindMismatch: 'Исполнитель не соответствует виду медиа.',
  requestShaMissing: 'Подготовка не вернула SHA запроса.',
  executorRequestMismatch: 'Исполнитель не соответствует подготовленному запросу.',
  requestChanged: 'Подготовленный запрос изменён или относится к другому медиа.',
  requestInputsDamaged: 'Повреждены входы подготовленного запроса.',
  requestInputChanged: 'Промпт или вход изменён: требуется новая подготовка.',
  alreadySubmitted: 'Эта попытка уже отправлялась; продолжите её через resume.',
  originalsIncomplete: 'Оригиналы ещё не сохранены полностью.',
  originalListDamaged: 'Повреждён список оригиналов.',
  originalChanged: 'Сохранённый оригинал изменён.',
  originalHashMismatch: 'Хеш оригинала отличается от сохранённого.',
  invalidImage: 'Результат не является изображением с корректными размерами.',
  imageExtensionMismatch: 'Расширение оригинала не соответствует фактическому формату изображения. Исходный файл сохранён.',
  invalidVideo: 'Результат не является корректным видео MP4.',
  invalidCapabilities: (title: string) => `${title} вернул неверное объявление возможностей.`,
  invalidCapabilityCommands: (title: string) => `${title} вернул неверный состав команд возможностей.`,
  capabilitiesNotConfirmed: (title: string) => `${title} не подтвердил возможности.`
} as const;
