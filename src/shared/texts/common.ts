/** Общие русские подписи и сообщения; правила владения описаны в @link ../../../docs/ui/texts.md. */
export const commonTexts = {
  cancel: 'Отмена',
  delete: 'Удалить',
  refresh: 'Обновить',
  retry: 'Повторить',
  stop: 'Остановить',
  log: 'Журнал',
  close: 'Закрыть',
  back: 'Назад',
  next: 'Вперёд',
  save: 'Сохранить',
  apply: 'Применить',
  add: 'Добавить',
  create: 'Создать',
  accept: 'Принять',
  rebuild: 'Пересобрать',
  more: 'Ещё',
  copied: 'Скопировано',
  checking: 'Проверка',
  waitForCheck: 'Дождитесь окончания проверки.',
  waitForSaving: 'Дождитесь окончания сохранения.',
  model: 'Модель',
  notSelected: 'Не выбрано',
  notSpecified: 'Не задано',
  saving: 'Сохранение',
  resetChanges: 'Сбросить правки',
  rename: 'Переименовать',
  remove: 'Убрать',
  noChangesToSave: 'Нет изменений для сохранения.',
  noUnsavedChanges: 'Нет несохранённых правок.',
  waitForCurrentOperation: 'Дождитесь окончания текущей операции.',
  browse: 'Обзор',
  title: 'Название',
  code: 'Код',
  label: 'Подпись',
  type: 'Тип',
  chooseFile: 'Выбрать файл',
  chooseFiles: 'Выбрать файлы',
  open: 'Открыть',
  run: 'Запустить',
  check: 'Проверить',
  build: 'Собрать',
  hide: 'Скрыть',
  watch: 'Смотреть',
  openFolder: 'Открыть папку',
  clearSelection: 'Снять выбор',
  unsavedChanges: 'Есть несохранённые правки',
  originalSize: 'Оригинальный размер (1:1)',
  operationPending: 'Дождитесь завершения текущей операции.',
  unavailable: ({ purpose, reason }: { purpose: string; reason: string }) => `${purpose}. Недоступно: ${reason}`,
  job: {
    failed: 'Действие не выполнено',
    completed: 'Завершено',
    error: 'Ошибка',
    cancelled: 'Остановлено',
    failedWithCode: ({ code }: { code: number | null | undefined }) => `Задание завершилось с кодом ${code}. Подробности доступны в журнале.`,
    openLog: 'Открыть журнал',
    done: ({ title }: { title: string }) => `${title}: выполнено.`,
    running: 'Выполняется',
    interrupted: 'Прервано'
  },
  // Общие поля обозначают те же данные в редакторе сцены и в сравнении предложения.
  fields: {
    name: 'Имя',
    shortName: 'Краткое имя',
    shortLabel: 'Короткая подпись',
    action: 'Действие',
    startSeconds: 'Начало, с',
    endSeconds: 'Конец, с',
    entities: 'Участники',
    lipSync: 'Липсинк',
    maxShotSeconds: 'Максимум плана, с',
    hint: 'Подсказка',
    references: 'Референсы'
  },
  media: {
    video: 'Видео',
    image: 'Изображение',
    audio: 'Аудио',
    card: 'Карточка',
    firstFrame: 'Первый кадр',
    keyframe: 'Опора',
    acceptedEdit: 'Принятый монтаж',
    videoMissing: 'Видео отсутствует',
    fileMissing: 'файла нет'
  },
  // Управление плеером одинаково в разметке песни и монтаже пробы.
  player: { pause: 'Пауза', play: 'Воспроизвести', volume: 'Громкость' },
  agent: { label: 'Агент', choose: 'Сначала выберите агента.', checking: 'Проверка агента' },
  // Коды свойств проверяются одинаково в словаре кастинга и редакторе состояния.
  stateProperty: {
    codeRequired: 'Введите код свойства.',
    codeInvalid: 'Код начинается со строчной латинской буквы и содержит только a–z, цифры и «_».',
    codeExample: 'например, helmet',
    dictionaryTitle: 'Словарь свойств'
  },
  // Одни данные состояния плана видны в редакторе, списке сцен и общей карточке.
  shot: {
    progress: 'в работе',
    stale: 'постановка изменена',
    stateTitle: 'Состояние героев и мира',
    beforeState: 'На первый кадр',
    afterState: 'На последний кадр'
  },
  runtime: {
    updateViewsStep: 'карточки и представления',
    rootMissing: 'Корень комплекса не найден.',
    pythonRequired: 'Нужен Python: проверьте его на странице «Среда».',
    applicationStopping: 'Приложение завершает работу.'
  },
  project: {
    notFound: 'Папка проекта не найдена. Выберите её заново.',
    manifestMissing: 'В папке нет plan/project.json.',
    nameRequired: 'Введите название проекта.',
    nameEmpty: 'Название проекта не может быть пустым.',
    settings: 'Настройки проекта',
    castDamaged: 'plan/cast.json повреждён.'
  },
  // Сценарий и производство показывают один жизненный цикл предложения агента.
  proposal: {
    interrupted: 'Задание прервано; подготовьте новое предложение.',
    applying: 'Применяем предложение',
    discard: 'Отклонить предложение',
    discardConfirm: 'Отклонить',
    resolveCurrent: 'Сначала примените или отклоните текущее предложение.',
    applied: 'Предложение применено',
    appliedSentence: 'Предложение применено.'
  },
  generation: {
    // Подготовка запроса и запуск задания опор проверяют одни входы и показывают одну причину отказа.
    frameDescriptionsRequired: 'Сначала подготовьте описания опор.',
    insufficientCredits: 'Кредитов недостаточно: пополните баланс и обновите стоимость.',
    confirmPrompt: 'Вы уверены, что промпт правильный?'
  },
  // Одинаковая постановка показывается и в сценах, и в карточке аниматика; жирные подписи остаются React-слотами.
  staging: {
    camera: '{label} {camera}',
    cameraLabel: 'Камера.',
    cameraMissing: 'не задана',
    action: '{label} {action}',
    actionLabel: 'Действие.',
    actionMissing: 'не задано'
  },
  scenario: {
    missing: 'Сначала нужен сценарий',
    requiredForWork: 'Сначала нужен сценарий. Создайте его на странице «Сценарий».',
    empty: 'В сценарии пока нет сцен',
    invalid: 'Не удалось прочитать сценарий',
    create: 'Создайте сценарий и добавьте в него сцены.',
    addScenes: 'Добавьте сцены на странице «Сценарий», чтобы продолжить работу.',
    repair: 'Проверьте сценарий на странице «Сценарий», затем обновите эту страницу.',
    open: 'Открыть сценарий',
    loading: 'Читаем сценарий…'
  },
  format: {
    bytes: (value: number) => `${value} Б`,
    kilobytes: (value: string) => `${value} КБ`,
    megabytes: (value: string) => `${value} МБ`,
    unknownDuration: 'длительность не определена'
  },
  files: { images: 'Изображения', text: 'Текст' },
  diagnostics: {
    crashNotice: 'Прошлый сеанс SongFrame завершился аварийно. Подробности и отчёт для разработчика — на странице «Журнал заданий».'
  },
  pageLoading: 'Страница загружается',
  network: {
    dismiss: 'Скрыть сообщение',
    actionOffline: 'Нет подключения к сети. Действие станет доступно после восстановления связи.',
    offline:
      'Нет подключения к сети. Генерация, задания агента, вход в сервис генерации и загрузка модели недоступны до восстановления связи; просмотр и правка проекта работают.'
  },
  shell: {
    openProjectFolder: ({ path }: { path: string }) => `Открыть папку проекта: ${path}`,
    openProjectFolderFailed: ({ reason }: { reason: string }) => `Не удалось открыть папку проекта: ${reason}`,
    noProject: 'Проект не выбран',
    lightTheme: 'Светлая тема',
    darkTheme: 'Тёмная тема',
    stage: ({ stage }: { stage: number }) => `этап ${stage}`,
    availableAtStage: ({ stage }: { stage: number }) => `Появится на этапе ${stage}`,
    selectProject: 'Сначала откройте или создайте проект на странице «Проекты».'
  }
} as const;
