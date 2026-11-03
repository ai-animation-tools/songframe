import { countLabel } from '../plural';
/** Подписи локальной сборки производного плана; постановка остаётся только контекстом для решения пользователя. */
export const derivedShotTexts = {
  heading: 'Сборка производного плана',
  explanation:
    'Выберите способ использования принятого клипа источника. Сборка выполняется локально и не расходует кредиты; готовый предпросмотр принимается отдельно.',
  source: ({ shot, title }: { shot: string; title: string }) => `Источник: ${shot}${title ? ` · ${title}` : ''}`,
  derivedFrom: ({ source }: { source: string }) => `Из материала ${source}`,
  openBuilder: ({ shot }: { shot: string }) => `Открыть сборку производного плана ${shot}`,
  sourceVideo: 'Принятый клип источника',
  previewVideo: 'Предпросмотр производного плана',
  sourceFrames: ({ frames }: { frames: number }) => `Источник: ${countLabel(frames, 'кадр', 'кадра', 'кадров')} · ${(frames / 30).toFixed(3)} с · 30 FPS`,
  targetFrames: ({ frames }: { frames: number }) => `Цель: ${countLabel(frames, 'кадр', 'кадра', 'кадров')} · ${(frames / 30).toFixed(3)} с · 30 FPS`,
  action: 'Действие по сценарию (для справки)',
  actionHint: 'Текст постановки не выбирает операции автоматически. Задайте рецепт ниже.',
  mode: 'Способ использования',
  chooseMode: 'Выберите способ',
  modes: { trim: 'Обрезка', fit: 'Подогнать скоростью', repeat: 'Повтор участка', still: 'Стоп-кадр' },
  start: 'Начальный кадр',
  end: 'Конечный кадр (не включается)',
  frame: 'Кадр для остановки',
  frameHint: 'Нумерация с 0, только целые кадры принятого клипа источника.',
  intervalHint: 'Участок от начального кадра до конечного, не включая конечный.',
  chooseModeReason: 'Сначала выберите способ использования материала.',
  invalidFrames: 'Укажите целые неотрицательные номера кадров; конец участка должен быть больше начала.',
  noChanges: 'Нет изменений для сохранения.',
  busy: 'Дождитесь завершения текущей операции.',
  dirty: 'Есть несохранённые правки',
  saveFirst: 'Сохраните рецепт или сбросьте правки; затем соберите новый предпросмотр.',
  build: 'Собрать предпросмотр',
  rebuild: 'Собрать заново',
  accept: 'Принять результат',
  replace: 'Заменить принятый комплект',
  replaceTitle: 'Заменить результат производного плана?',
  replaceDescription: ({ shot }: { shot: string }) =>
    `Принятый комплект ${shot} будет заменён показанным предпросмотром. Предыдущий комплект сохранится в истории.`,
  preview: 'Готовый предпросмотр',
  noPreview: 'Сначала соберите предпросмотр и проверьте его перед приёмкой.',
  stale: 'Предпросмотр устарел. Проверьте источник, музыку и рецепт, затем соберите заново.',
  previewDiffers: 'Рецепт отличается от показанного предпросмотра. Соберите новый результат.',
  alreadyAccepted: 'Этот предпросмотр уже принят.',
  saved: 'Рецепт производного плана сохранён.',
  accepted: 'Результат производного плана принят.',
  loading: 'Читаем материал и рецепт…',
  retry: 'Повторить загрузку',
  trimInfo: ({ start, end, frames }: { start: number; end: number; frames: number }) =>
    `Кадры [${start}, ${end}) без изменения скорости → ${countLabel(frames, 'кадр', 'кадра', 'кадров')}.`,
  fitInfo: ({ length, frames, speed }: { length: number; frames: number; speed: string }) =>
    `Участок: ${countLabel(length, 'кадр', 'кадра', 'кадров')} → ${countLabel(frames, 'кадр', 'кадра', 'кадров')}; скорость ${speed}×.`,
  slowed: 'Движение будет замедлено.',
  accelerated: 'Движение будет ускорено.',
  sameSpeed: 'Скорость не изменится.',
  repeatInfo: ({ length, cycles, rest, frames }: { length: number; cycles: number; rest: number; frames: number }) =>
    `Участок: ${countLabel(length, 'кадр', 'кадра', 'кадров')}; полных повторов ${cycles}, затем ${countLabel(rest, 'кадр', 'кадра', 'кадров')} участка → ${countLabel(frames, 'кадр', 'кадра', 'кадров')}.`,
  stillInfo: ({ frame, frames }: { frame: number; frames: number }) =>
    `Кадр ${frame} удерживается ${countLabel(frames, 'кадр', 'кадра', 'кадров')} без движения.`
} as const;
