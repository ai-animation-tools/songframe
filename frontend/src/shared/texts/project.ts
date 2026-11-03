import { commonTexts } from './common';

import { countLabel } from '../plural';

/** Тексты обзора проекта и настроек генерации; особенности исполнителя передаются из реестра. */
export const projectTexts = {
  noProject: 'Проект не выбран.',
  bundle: {
    summary: ({ shots, videos, copied }: { shots: number; videos: number; copied: number }) =>
      `Планов ${shots}, из них видео ${videos}, скопировано файлов ${copied}.`,
    videos: ({ videos, shots }: { videos: number; shots: number }) => `${videos} видео из ${shots}`,
    removeDescription: ({ folder }: { folder: string | undefined }) =>
      `Будет удалена папка «${folder}» со всем содержимым, включая скопированные медиа. Исходные файлы проекта сохранятся.`,
    built: 'Пакет для монтажёра собран',
    failed: 'Сборка пакета завершилась с ошибкой',
    pickFolder: 'Где создать папку пакета (вне проекта)',
    waitBuilding: 'Дождитесь окончания сборки пакета.',
    waitStarting: 'Дождитесь запуска сборки.',
    waitDeleting: 'Дождитесь удаления пакета.',
    pythonRequired: commonTexts.runtime.pythonRequired,
    removed: 'Пакет для монтажёра удалён',
    title: 'Пакет для монтажёра',
    description:
      'Таблица планов с таймкодами песни и выбранными участками оригиналов, EDL, FCPXML с точной шкалой аниматика, строки песни и README. С копированием медиа в пакет попадают оригиналы, принятые клипы, опоры, промпты, WAV, карточки неготовых планов, референсы и песня; без копирования пути относительны проекту. Неготовые планы идут карточками.',
    folder: 'Папка пакета',
    folderHelp: 'Пустая папка: внутри проекта только в plan/batches, иначе любая вне проекта',
    outsideProject: 'Вне проекта',
    copyMedia: 'Скопировать медиа в пакет',
    building: 'Собираем',
    build: 'Собрать пакет',
    buildFailed: 'Сборка не удалась, подробности в журнале заданий.',
    builtList: 'Собранные пакеты в plan/batches',
    withMedia: 'с медиа',
    remove: 'Удалить пакет для монтажёра'
  },
  generation: {
    savedProvider: ({ provider }: { provider: string }) => `Сохранённый провайдер: ${provider}. Для запуска выберите его в меню и сохраните настройки.`,
    fromFile: (value: string) => `${value} (из файла)`,
    modelChoice: ({ model, available }: { model: string; available: boolean }) => `${model}${available ? '' : ' (недоступна)'}`,
    modelUnavailable: ({ model }: { model: string | undefined }) =>
      `Модель ${model} недоступна у провайдера. Выберите доступную или автоматический подбор модели.`,
    agentImageModel: ({ provider }: { provider: string }) => `Модель агента ${provider} для изображений`,
    agentModelUnavailable: ({ model, defaultModelLabel }: { model: string | undefined; defaultModelLabel: string }) =>
      `Модель ${model} недоступна у провайдера. Выберите доступную модель или пункт «${defaultModelLabel}».`,
    agentModelHelp: ({ provider }: { provider: string }) =>
      `По умолчанию используется модель из настроек ${provider}. Здесь выбирается модель агента, который готовит изображение, а не модель самого генератора изображений.`,
    resolutionUnsupported: ({ resolution, preferredModel }: { resolution: string; preferredModel: boolean }) =>
      `Разрешение ${resolution} не поддерживается ${preferredModel ? 'предпочтительной моделью' : 'доступными моделями'}. Выберите доступное или автоматический подбор модели.`,
    aspectUnsupported: ({ aspect, preferredModel }: { aspect: string; preferredModel: boolean }) =>
      `Пропорции ${aspect} не поддерживаются ${preferredModel ? 'предпочтительной моделью' : 'доступными моделями'}. Выберите доступное или автоматический подбор модели.`,
    resolutionUnavailable: (resolution: string) => `${resolution} (недоступно для модели)`,
    aspectUnavailable: (aspect: string) => `${aspect} (недоступны для модели)`,
    agentExecution: ({ provider }: { provider: string }) =>
      `Генерацию выполняет ${provider} встроенным инструментом изображений. Доступные размеры и форматы определяет исполнитель при подготовке запроса. Сейчас создаётся один вариант для каждой опоры. Параметры запроса — количество вариантов, разрешение и пропорции — к этому исполнителю не применяются.`,
    automaticModel: 'Автоматически по задаче',
    imageMissing: 'Исполнитель изображений не задан. Добавьте его перед подготовкой опорных кадров.',
    imageProvider: 'Провайдер изображений',
    providerUnselected: 'Провайдер не выбран. Сохранение оставит генерацию отключённой.',
    chooseImageProvider: 'Выберите провайдера изображений и сохраните настройки.',
    preferredImageModel: 'Предпочтительная модель изображений',
    modelHelp: 'Автоматически — подбор по требованиям задачи. Выбранная модель — предпочтение; несовместимая будет заменена с объяснением при согласовании.',
    imageResolution: 'Разрешение изображений',
    chooseImageResolution: 'Выберите разрешение изображений.',
    imageResolutionHelp: 'Разрешения выбранной модели; при автоматическом подборе — всех доступных моделей. Можно ввести вручную.',
    imageAspect: 'Пропорции изображений',
    chooseImageAspect: 'Выберите пропорции изображений.',
    imageAspectHelp: 'Пропорции выбранной модели: от широких к вертикальным, auto в конце. При автоматическом подборе — варианты всех моделей.',
    chooseAspect: 'Выберите пропорции',
    imageCount: 'Количество изображений',
    imageCountInvalid: 'Введите целое количество изображений от 1.',
    imageCountHelp: 'Число вариантов одной опоры в запросе, а не число кадров. Больше вариантов может увеличить стоимость.',
    imagePreferences: 'Параметры сохраняются как предпочтения. Исполнитель подбирает доступную модель под требования запроса.',
    videoMissing: 'Предпочтения видео не заданы. Добавьте их перед подготовкой видео.',
    videoPreferences: 'Параметры ниже — предпочтения проекта. Исполнитель подбирает доступную модель под требования запроса.',
    videoProvider: 'Провайдер видео',
    chooseVideoProvider: 'Выберите провайдера видео и сохраните настройки.',
    preferredVideoModel: 'Предпочтительная модель видео',
    videoResolution: 'Разрешение видео',
    chooseVideoResolution: 'Выберите разрешение видео.',
    videoResolutionHelp: 'Разрешения выбранной модели; при автоматическом подборе — всех доступных моделей.',
    videoAspect: 'Пропорции видео',
    chooseVideoAspect: 'Выберите пропорции видео.',
    videoAspectHelp: 'Пропорции выбранной модели; при автоматическом подборе — всех доступных моделей.',
    durationRule: 'Правило длительности',
    chooseDurationRule: 'Выберите известное правило длительности.',
    durationRuleHelp: 'Как выбирать длительность запроса относительно окна сцены на шкале'
  },
  capabilities: {
    checkedAt: 'Проверено: {date}',
    failed: ({ error }: { error: string }) => `Не удалось проверить возможности: ${error}`,
    unavailable: ({ provider }: { provider: string }) => `${provider} сейчас недоступен.`,
    incomplete: ({ provider }: { provider: string }) => `${provider} доступен, но часть сведений получить не удалось. Нажмите «Повторить проверку».`,
    models: ({ provider, count }: { provider: string; count: number }) => `${provider} доступен. Моделей для выбора: ${count}.`,
    available: ({ provider }: { provider: string }) => `${provider} доступен.`,
    automaticCheck:
      'Модели и параметры провайдера проверяются автоматически при открытии и смене провайдера. Настройки не сохраняются, генерация не запускается.',
    checking: 'Проверяем возможности провайдера',
    checkWhenOnline: 'Возможности провайдера проверятся после подключения к сети.',
    retry: 'Повторить проверку',
    defaultNote: 'Проверка не запускает генерацию. Подойдёт ли модель для конкретного плана, приложение проверит перед запросом.'
  },
  nextStep: {
    scenes: ({ done, total }: { done: number; total: number }) => `Сцены: ${done} из ${total}`,
    title: 'Следующий шаг',
    invalidTitle: 'Папка не является проектом',
    invalidText: 'Нет plan/project.json. Создайте проект заново или выберите другую папку.',
    sourcesTitle: 'Добавить исходники',
    sourcesText: 'Трек, текст песни, идея клипа, по желанию обложка и референсы.',
    toSources: 'К исходникам',
    timingTitle: 'Разметить трек',
    timingText: 'Черновик делает кнопка «Разметить» на странице таймингов; затем границы строк подтверждаются на слух.',
    toTiming: 'К таймингам',
    scenesTitle: 'Собрать реестр сцен',
    scenesText: 'Трактовка есть. Постройте каркас сцен и заполните постановку в редакторе или поручите её агенту на странице сценария.',
    toScenario: 'К сценарию',
    treatmentTitle: 'Написать трактовку',
    treatmentText: 'Кастинг есть. Разделите песню на части с действием и участниками в редакторе или поручите трактовку агенту на странице сценария.',
    castTitle: 'Собрать кастинг',
    castText: 'Сущности клипа из референсов, роль, внешность и начальное состояние мира и героев. Это основа непрерывности между сценами.',
    toCast: 'К кастингу',
    productionTitle: 'Начать производство сцен',
    productionText:
      'Описание, опоры, промпт и запрос каждого плана готовит агент по кнопкам страницы «Производство»; там же вы подтверждаете их, стоимость и результат. Готовность сцены определяется комплектом в assets/shots.',
    toProduction: 'К производству',
    continueProduction: 'Продолжайте принимать сцены; после последней соберите и примите аниматик.',
    toAnimatic: 'К аниматику',
    completeTitle: 'Клип завершён',
    completeText: 'Все сцены приняты, аниматик собран по актуальному реестру и принят. Пакет для монтажёра собирается ниже на этой странице.'
  },
  checks: {
    shots: (count: number) => countLabel(count, 'план', 'плана', 'планов'),
    acceptedCount: ({ done, total }: { done: number; total: number }) => `${done} из ${total}`,
    sources: 'Исходники: трек, текст, идея (source/manifest.json)',
    timing: 'Разметка трека (plan/audio/timing.json)',
    cast: 'Кастинг (plan/cast.json)',
    treatment: 'Трактовка (plan/treatment.json)',
    scenes: 'Реестр сцен (plan/scenes.json)',
    accepted: 'Принятые сцены (assets/shots)',
    animaticBuilt: 'Аниматик собран по текущему реестру',
    stale: 'устарел',
    animaticApproved: 'Аниматик принят',
    previousApproved: 'принято прежнее состояние',
    title: 'Признаки состояния'
  },
  changeProject: 'Сменить проект',
  rename: {
    done: 'Проект переименован',
    title: 'Переименовать проект',
    name: 'Название проекта',
    help: 'Папка проекта и имя MP4 останутся прежними.',
    wait: 'Дождитесь окончания переименования.',
    nameRequired: commonTexts.project.nameRequired,
    nameUnchanged: 'Введите новое название: оно совпадает с текущим.'
  },
  agentInstructions: {
    title: 'Постоянные инструкции текстовому агенту',
    help: 'Сохраняются в проекте и добавляются к каждому заданию текстового агента, включая повтор и доработку.',
    locked: 'Поле заблокировано. Для редактирования нажмите «Разблокировать».',
    editing: 'Поле разблокировано до сохранения или смены проекта.',
    chooseAgent: 'Для редактирования выберите текстового агента в настройках приложения.',
    unlock: 'Разблокировать',
    unlockTitle: 'Разблокировать постоянные инструкции',
    warning: 'Изменяйте содержимое этого поля только если точно понимаете что делаете.',
    invalid: 'plan/project.json: agent_instructions должен быть строкой.'
  },
  settings: {
    // Порядок и названия целей сохранены для переходов LinkedText к полям с ошибками.
    fixBeforeSave: ({ animaticError, videoValid, imageValid }: { animaticError: boolean; videoValid: boolean; imageValid: boolean }) =>
      `Исправьте ошибки перед сохранением: ${[
        animaticError ? 'поле «Имя MP4 аниматика»' : null,
        videoValid ? null : 'блок «Генерация видео»',
        imageValid ? null : 'блок «Генерация изображений»'
      ]
        .filter(Boolean)
        .join(', ')}.`,
    reading: 'Читаем plan/project.json…',
    waitSaving: 'Дождитесь окончания записи настроек.',
    invalidFields: 'Исправьте ошибки в отмеченных полях формы.',
    saved: 'Настройки проекта записаны в plan/project.json',
    title: commonTexts.project.settings,
    animaticNameInvalid: 'Укажите имя .mp4: буквы, цифры, точки и дефисы, без пути к папке.',
    animaticNameHelp: 'Без пути к папке',
    resetTitle: 'Сбросить правки настроек проекта',
    resetDescription: 'Все несохранённые изменения настроек будут потеряны. Форма вернётся к последним сохранённым значениям.',
    noUnsavedChanges: commonTexts.noUnsavedChanges,
    preferencesHelp:
      'Прочие поля файла сохраняются как есть. Изменение настроек не трогает уже подготовленные запросы: повтор по снимку с другим форматом остановится.',
    filename: 'plan/project.json'
  }
} as const;
