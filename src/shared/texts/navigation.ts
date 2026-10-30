/** Названия страниц и целей текстовых ссылок; маршруты и якоря остаются в навигации renderer. */
export const navigationTexts = {
  pages: {
    projects: 'Проекты',
    project: 'Проект',
    newProject: 'Новый проект',
    sources: 'Исходники',
    timing: 'Тайминги',
    cast: 'Кастинг',
    scenario: 'Сценарий',
    production: 'Производство',
    scenes: 'Сцены',
    montage: 'Монтаж пробы',
    checks: 'Проверки',
    animatic: 'Аниматик',
    jobs: 'Журнал заданий',
    environment: 'Среда',
    settings: 'Настройки',
    help: 'Справка'
  },
  blocks: {
    productionWorkflow: 'Подготовка плана',
    productionSpeech: 'Речь',
    productionLipSync: 'Речь (липсинк)',
    productionQueue: 'Очередь',
    checksProject: 'Проверки проекта',
    checksReview: 'Проба стыков',
    projectVideoGeneration: 'Генерация видео',
    projectImageGeneration: 'Генерация изображений',
    projectAnimaticName: 'Имя MP4 аниматика'
  },
  // Падежные формы нужны распознаванию ссылок в уже существующих русских сообщениях.
  pageForms: {
    sourcesPrepositional: 'Исходниках',
    timingPrepositional: 'Таймингах',
    timingGenitive: 'Таймингов',
    castPrepositional: 'Кастинге',
    scenarioPrepositional: 'Сценарии',
    productionPrepositional: 'Производстве',
    checksPrepositional: 'Проверках',
    animaticPrepositional: 'Аниматике',
    jobsPrepositional: 'Журнале заданий',
    environmentPrepositional: 'Среде',
    settingsPrepositional: 'Настройках',
    helpPrepositional: 'Справке'
  }
} as const;
