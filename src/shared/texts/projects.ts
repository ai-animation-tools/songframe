import { commonTexts } from './common';

/** Тексты создания проекта и истории папок; технические значения и проверки остаются у страниц. */
export const projectsTexts = {
  // Main возвращает прежние готовые фразы; формат данных проекта и порядок проверок не меняются.
  main: {
    nameRequired: 'Укажите название проекта.',
    pathRequired: 'Укажите полный путь к папке проекта.',
    absolutePathRequired: 'Путь должен быть абсолютным.',
    targetExists: 'Папка уже существует: выберите новый путь или откройте её как существующий проект.',
    parentMissing: ({ path }: { path: string }) => `Родительская папка не существует: ${path}`,
    invalidAnimaticName: 'Имя MP4: латиница, цифры, точка, дефис, подчёркивание и расширение .mp4.',
    markerMissingAtPath: ({ path }: { path: string }) => `В папке нет plan/project.json с названием проекта: ${path}`,
    emptyName: commonTexts.project.nameEmpty,
    invalidNameCharacter: 'Название проекта содержит недопустимый символ.',
    invalidMarker: 'В папке нет корректного plan/project.json с названием проекта.',
    templateUnavailable: 'Корень комплекса не найден: шаблон проекта недоступен. Укажите его на странице «Среда».',
    templateMissing: ({ path }: { path: string }) => `Шаблон проекта не найден: ${path}`,
    invalidCurrentFile: ({ path }: { path: string }) => `Неверный формат ${path}. Файл сохранён; выберите резервную копию или исправьте path.`,
    invalidHistoryFile: ({ path }: { path: string }) => `Неверный формат ${path}. Файл сохранён; исправьте список projects.`,
    status: {
      markerMissing: 'Нет plan/project.json с названием проекта.',
      incompleteSources: 'source/manifest.json есть, но в нём нет трека, текста песни или идеи.',
      damagedSources: 'source/manifest.json повреждён.',
      timingLinesMissing: 'plan/audio/timing.json не содержит строк разметки.',
      damagedCast: commonTexts.project.castDamaged,
      damagedTreatment: 'plan/treatment.json повреждён или пуст.',
      damagedScenes: 'plan/scenes.json повреждён или не содержит сцен.',
      staleShots: ({ ids }: { ids: readonly string[] }) => `Постановка изменена после приёмки: ${ids.join(', ')}. Нужно новое производство этих планов.`,
      derivedShotsNeedReview: ({ ids }: { ids: readonly string[] }) =>
        `Не подтверждена актуальность производных планов: ${ids.join(', ')}. Проверьте версию источника и приёмку этих планов.`,
      orphanKits: ({ ids }: { ids: readonly string[] }) => `Комплекты без сцены в реестре: ${ids.join(', ')}.`,
      animaticNotBuilt: 'Все сцены приняты, но полный аниматик ещё не собран.',
      staleAnimatic: 'Аниматик собран по устаревшему реестру или входам: нужна пересборка.',
      animaticNotApproved: 'Аниматик собран, но не принят в plan/production-status.json.'
    }
  },
  created: ({ name }: { name: string }) => `Проект «${name}» создан`,
  creating: 'Дождитесь создания проекта.',
  resourcesMissing: 'Ресурсы приложения не найдены: см. страницу «Среда».',
  nameRequired: commonTexts.project.nameRequired,
  folderRequired: 'Укажите папку проекта.',
  formProblems: 'Исправьте проблемы, перечисленные в форме.',
  validating: 'Дождитесь окончания проверки формы.',
  templateUnavailable: 'Ресурсы приложения не найдены, шаблон проекта недоступен. Подробности на странице «Среда».',
  afterCreation: 'После создания откроется страница исходников: трек, текст песни, идея клипа, обложка и референсы.',
  chooseParent: 'Где создать папку проекта',
  folderPath: 'Полный путь к новой папке',
  folderHelp: 'Папка ещё не должна существовать. Она будет заполнена из шаблона; репозиторий Git создаётся, если Git установлен. Без него проект тоже работает',
  parentFolder: 'Родительская папка',
  clipName: 'Название клипа',
  nameHelp: 'Попадёт в plan/project.json, README и заголовки документов',
  animaticName: 'Имя MP4 аниматика (необязательно)',
  animaticNameHelp: 'Латиница, цифры, дефис; по умолчанию образуется из названия',
  chooseProjectFolder: 'Папка проекта клипа',
  toolsUnavailable: 'Ресурсы приложения не найдены: создание проектов и инструменты недоступны, просмотр работает. Подробности на странице «Среда».',
  emptyHistory: 'История пуста. Откройте папку существующего клипа или создайте новый проект.',
  forget: ({ name }: { name: string }) => `Убрать проект «${name}» из истории`,
  forgetDescription: 'Из истории будет удалена только запись о проекте. Папка проекта и все её файлы останутся на диске.',
  opening: 'Дождитесь открытия проекта.',
  forgetConfirm: 'Убрать из истории',
  current: 'текущий',
  // Дата уже отформатирована владельцем; пустая дата сохраняет прежнее отсутствие суффикса.
  historyDetails: ({ path, exists, openedAt }: { path: string; exists: boolean; openedAt: string | null | undefined }) =>
    `${path}${exists ? '' : ' (папка не найдена)'}${openedAt ? ` · открыт ${openedAt}` : ''}`
} as const;
