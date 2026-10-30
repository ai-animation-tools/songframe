import { commonTexts } from './common';

/** Тексты просмотра и принятия аниматика; правила — @link ../../../docs/ui/texts.md. */
export const animaticTexts = {
  // Главный процесс возвращает готовые фразы; данные проекта и формат IPC не меняются.
  main: {
    videoMissing: ({ filename }: { filename: string | null | undefined }) =>
      `MP4 сборки не найден: ${filename ?? 'имя не записано'}. Соберите аниматик заново.`,
    registryChanged: 'Реестр сцен изменился после сборки: аниматик устарел, нужна пересборка.',
    manifestCorrupt: 'plan/animatic/latest/manifest.json повреждён.',
    updateViewsStep: commonTexts.runtime.updateViewsStep,
    checkInputsStep: 'проверка входов',
    buildStep: 'сборка аниматика',
    buildTitle: 'Сборка аниматика',
    buildRequired: 'Нет собранного аниматика: сначала соберите его.',
    freshBuildRequired: 'Аниматик собран по устаревшему реестру или входам: пересоберите перед принятием.',
    inputHashMissing: ({ name }: { name: string }) => `Нет сохранённого хеша входа ${name}: пересоберите аниматик для проверки свежести.`,
    inputChanged: ({ name }: { name: string }) => `Вход аниматика изменён или отсутствует: ${name}. Нужна пересборка.`,
    projectInputsMissing: 'В манифесте аниматика отсутствует обязательное поле project_inputs; пересоберите аниматик.',
    projectInputsChanged: 'Значимые поля plan/project.json изменены или snapshot project_inputs повреждён; нужна пересборка аниматика.',
    shotInputMissing: ({ shot }: { shot: string }) => `${shot}: в манифесте нет входного файла; нужна пересборка.`,
    acceptedEditChanged: ({ shot }: { shot: string }) => `${shot}: выбранный принятый монтаж изменился после сборки; нужна пересборка.`,
    acceptedEditAdded: ({ shot }: { shot: string }) => `${shot}: вместо карточки появился принятый монтаж; нужна пересборка.`,
    keyframesChanged: ({ shot }: { shot: string }) => `${shot}: выбор принятых опор изменился после сборки; нужна пересборка.`,
    keyframeSourcesMissing: ({ shot }: { shot: string }) => `${shot}: нет сведений об исходных опорах старой сборки; пересоберите аниматик.`,
    referencePathMissing: ({ shot, id }: { shot: string; id: string }) => `${shot}: нет пути референса ${id}; нужна пересборка.`
  },
  chooseShot: 'Запустите видео или выберите план на полосе глав.',
  media: { video: 'Анимация', card: commonTexts.media.card, keyframes: 'Опоры' },
  jobFailed: ({ title }: { title: string }) => `${title}: ошибка, см. журнал`,
  jobReady: ({ title }: { title: string }) => `${title}: готово`,
  approvedNotice: 'Результат принят',
  reviewNotice: 'Возвращено на просмотр',
  buildPending: 'Дождитесь завершения сборки.',
  acceptance: {
    title: 'Принятие',
    accepted: 'Текущий результат принят.',
    scenarioChanged: 'Сценарий изменился после сборки. Пересоберите видео и просмотрите результат.',
    videoChanged: 'После пересборки результат изменился. Просмотрите его и примите заново.',
    reviewInstruction: 'Просмотрите видео целиком. Если результат устраивает, нажмите «Принять».',
    returnToReview: 'Вернуть на просмотр',
    approve: commonTexts.accept,
    rebuildScenario: 'Сценарий изменился после сборки: пересоберите видео.',
    buildFirst: 'Видео ещё не собрано: нажмите «Собрать».'
  },
  confirm: {
    approveTitle: 'Принять результат?',
    reviewTitle: 'Вернуть на просмотр?',
    return: 'Вернуть',
    approveDescription: 'Результат будет отмечен как принятый. Если видео изменится после пересборки, просмотрите его и примите заново.',
    reviewDescription: 'Результат снова будет ожидать просмотра и принятия.'
  },
  chapters: 'Главы',
  header: {
    accepted: 'принят',
    review: 'собран, на просмотре',
    stale: 'устарел',
    notBuilt: 'не собран',
    checkHint: 'Проверить материалы и длительности без сборки видео',
    rebuildHint: 'Обновить карточки и собрать видео. Текущий результат будет заменён',
    rebuild: commonTexts.rebuild,
    rebuildDescription: 'Текущий результат сборки будет заменён. После пересборки результат потребуется проверить заново.',
    buildHint: 'Обновить карточки и собрать видео'
  },
  // Слот даты сохраняет компонент DateTime и прежний пробел перед ним; грамматика первого переноса остаётся прежней.
  playbackSummary: ({
    time,
    duration,
    shots,
    video,
    keyframes,
    cards
  }: {
    time: string;
    duration: string;
    shots: number;
    video: number;
    keyframes: number;
    cards: number;
  }) => `${time} / ${duration} · ${shots} планов: ${video} анимация, ${keyframes} опоры, ${cards} карточки · собрано {builtAt}`,
  shot: {
    speech: 'речь',
    timing: ({ start, end, frames }: { start: string; end: string; frames: number }) => `${start}–${end} · ${frames} кадров`,
    sequence: ({ title }: { title: string }) => `Часть: ${title}`,
    lastCard: ({ shot }: { shot: string }) => `${shot} последняя опора`
  }
} as const;
