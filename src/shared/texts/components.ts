/** Подписи общих компонентов; поведение, оформление и технические значения остаются у компонентов. @link ../../../docs/ui/texts.md */
import { commonTexts } from './common';

export const componentsTexts = {
  agent: {
    chooseInSettings: 'Выберите агента в форме настроек.',
    notSelected: 'Агент не выбран'
  },
  aiProblem: {
    openSettings: 'Открыть настройки',
    projectSettings: commonTexts.project.settings
  },
  agentJob: {
    statuses: {
      running: commonTexts.job.running,
      completed: commonTexts.job.completed,
      failed: commonTexts.job.error,
      cancelled: commonTexts.job.cancelled,
      interrupted: commonTexts.job.interrupted
    },
    cancelling: 'Задание уже останавливается: дождитесь завершения.'
  },
  agentRetry: {
    title: 'Повторить задание',
    description:
      'Предыдущий запрос не сохраняется. Введите его заново: будет создано отдельное задание с текущими настройками агента. Агент подготовит предложение без изменения файлов проекта.',
    prompt: 'Запрос',
    context: 'Дополнительный контекст',
    waitForStart: 'Дождитесь запуска задания.',
    enterPrompt: 'Введите запрос для нового задания.',
    starting: 'Запуск'
  },
  gallery: {
    image: commonTexts.media.image,
    position: ({ kind, position, total }: { kind: string; position: number; total: number }) => `${kind} · ${position} / ${total}`,
    firstImage: 'Это первое изображение.',
    previousImage: 'Предыдущее изображение',
    lastImage: 'Это последнее изображение.',
    nextImage: 'Следующее изображение',
    originalSize: commonTexts.originalSize,
    openLarge: ({ label }: { label: string }) => `Открыть крупно: ${label}`
  },
  shot: {
    speech: 'речь',
    states: { planned: 'не начат', progress: commonTexts.shot.progress, completed: 'принят', stale: commonTexts.shot.stale, unknown: 'проблема' },
    pages: {
      production: { label: 'В производстве', title: 'на странице «Производство»' },
      scenario: { label: 'В сценарии', title: 'в реестре сцен на странице «Сценарий»' }
    },
    openPlan: ({ shot, title }: { shot: string; title: string }) => `Открыть план ${shot} ${title}`
  },
  job: {
    success: 'без ошибок',
    interrupted: 'прервано',
    exitCode: ({ code }: { code: number | null }) => `код ${code}`,
    previousSession: 'Прошлый сеанс',
    stepExitCode: ({ label, code }: { label: string; code: number }) => `${label}: код ${code}`,
    interruptedExplanation: ({ message }: { message: string }) =>
      `${message}. Результат задания неизвестен: проверьте его на рабочей странице и при необходимости запустите заново.`,
    emptyLog: 'Журнал пуст.',
    collapseLog: 'Свернуть журнал',
    fullLog: 'Весь журнал'
  },
  stateEditor: {
    enterKey: commonTexts.stateProperty.codeRequired,
    invalidKey: commonTexts.stateProperty.codeInvalid,
    duplicateKey: 'Такое свойство уже есть в списке.',
    removed: 'снято',
    inherited: ({ value }: { value: string }) => `унаследовано: ${value}`,
    willRemove: 'свойство будет снято',
    restore: 'Вернуть унаследованное',
    restoreProperty: ({ label }: { label: string }) => `Вернуть унаследованное свойство ${label}`,
    removeProperty: ({ label }: { label: string }) => `Снять свойство «${label}»`,
    removeDescription: 'Свойство будет снято из состояния сущности в этой сцене, включая унаследованное значение.',
    remove: 'Снять',
    customKey: 'Своё свойство (код)',
    customKeyExample: commonTexts.stateProperty.codeExample,
    customKeyHint:
      'Деталь состояния, которой нет среди полей выше. Код латиницей; после «+» появится поле для значения. Значение войдёт во врезку непрерывности и промпты опор, а следующие планы его унаследуют. Подпись, варианты и пункт проверки появятся, если добавить свойство в словарь кастинга.',
    addCustomProperty: 'Добавить своё свойство',
    noDictionary: 'У этого типа нет словаря свойств: добавьте свои ключи.'
  },
  fileDrop: {
    noNativePath: 'Перетащите сохранённый файл с диска или выберите его через диалог.',
    image: {
      fromDisk: 'Перетащите файл изображения с диска.',
      single: 'Для обложки выберите одно изображение.',
      allowed: 'Допустимы изображения PNG, JPG и WebP.',
      pickMultiple: 'Перетащите изображения сюда или нажмите, чтобы выбрать файлы.',
      pickSingle: 'Перетащите изображение сюда или нажмите, чтобы выбрать файл.',
      dropMultiple: 'Перетащите изображения сюда.',
      dropSingle: 'Перетащите изображение сюда.',
      formats: 'PNG, JPG, WebP.'
    },
    audio: {
      fromDisk: 'Перетащите MP3 с диска.',
      single: 'Для трека выберите один MP3.',
      allowed: 'Для трека допустим только файл MP3.',
      pick: 'Перетащите MP3 сюда или нажмите, чтобы выбрать файл.',
      drop: 'Перетащите MP3 сюда.'
    },
    text: {
      fromDisk: 'Перетащите текстовый файл с диска.',
      single: 'Перетащите один текстовый файл.',
      allowed: 'Допустимы файлы TXT и MD.',
      pick: 'Перетащите сюда TXT или MD либо нажмите, чтобы выбрать файл.',
      drop: 'Перетащите сюда TXT или MD.'
    }
  },
  readableValue: {
    keys: {
      id: commonTexts.code,
      title: commonTexts.title,
      direction: commonTexts.fields.action,
      start: commonTexts.fields.startSeconds,
      end: commonTexts.fields.endSeconds,
      entities: commonTexts.fields.entities,
      lipsync: commonTexts.fields.lipSync,
      max_shot_seconds: commonTexts.fields.maxShotSeconds,
      name: commonTexts.fields.name,
      short_name: commonTexts.fields.shortName,
      path: 'Файл',
      end_seconds: 'Конец песни, с',
      primary_reference: 'Главный референс',
      scene: 'План',
      phase: 'Момент',
      before: commonTexts.shot.beforeState,
      after: commonTexts.shot.afterState,
      key: 'Ключ',
      label: commonTexts.label,
      hint: commonTexts.fields.hint,
      values: 'Типовые значения',
      checklist: 'Проверка по кадру'
    },
    phases: { before: 'состояние на первый кадр', after: 'состояние на последний кадр', same: 'то же состояние' },
    empty: 'пусто',
    unchanged: 'без изменений',
    property: ({ label, value }: { label: string; value: string }) => `${label}: ${value}`,
    remove: 'снять',
    noProperties: 'без свойств',
    none: 'нет',
    emptyValue: '—',
    yes: 'Да',
    no: 'Нет',
    inheritedState: ({ scene, phase }: { scene: string; phase: string }) => `от плана ${scene}: ${phase}`
  }
} as const;
