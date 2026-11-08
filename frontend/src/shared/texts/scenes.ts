import { commonTexts } from './common';

import { countLabel } from '../plural';

/** Тексты обзора сцен и принятого монтажа; правила текстов описаны в @link ../../../docs/ui/texts.md. */
export const scenesTexts = {
  montageSelected: ({ count }: { count: number }) => `Монтаж выбранных (${count})`,
  selectForMontage: 'Отметьте сцены флажком «В монтажную пробу».',
  noVisibleScenes: 'Нет видимых сцен: измените фильтр или поиск.',
  markVisible: 'Отметить видимые',
  noMarkedScenes: 'Нет отмеченных сцен.',
  unmarkAll: 'Снять отметки',
  forMontage: 'В монтажную пробу',
  nothingFound: 'Ничего не найдено.',
  missingVideo: commonTexts.media.videoMissing,
  media: { video: 'анимация', card: 'карточка', keyframes: 'опоры' },
  summary: {
    completed: ({ count }: { count: number }) => `принято ${count}`,
    stale: ({ count }: { count: number }) => `постановка изменена ${count}`,
    staleHint: 'Комплект принят по прежней постановке: нужно новое производство',
    progress: ({ count }: { count: number }) => `в работе ${count}`,
    planned: ({ count }: { count: number }) => `не начато ${count}`,
    acceptedDuration: ({ completed, duration }: { completed: string; duration: string }) => `${completed} из ${duration} принято`
  },
  timeline: {
    all: 'все',
    completed: 'принятые',
    stale: commonTexts.shot.stale,
    progress: commonTexts.shot.progress,
    planned: 'не начатые',
    search: 'Поиск планов',
    searchHint: 'По коду, строке, действию',
    visible: ({ visible, total, duration }: { visible: number; total: number; duration: string }) => `${visible} из ${total} · ${duration}`
  },
  details: {
    animaticMedia: ({ media }: { media: string }) => `в аниматике: ${media}`,
    timing: ({ start, end, frames, sequence }: { start: string; end: string; frames: number; sequence: string | null | undefined }) =>
      `${start}–${end} · ${countLabel(frames, 'кадр', 'кадра', 'кадров')} · ${sequence ?? ''}`,
    packageCount: ({ count }: { count: number }) => ` · пакетов: ${count}`,
    worldState: commonTexts.shot.stateTitle,
    firstFrame: commonTexts.shot.beforeState,
    lastFrame: commonTexts.shot.afterState,
    inAnimatic: 'В аниматике',
    assetFolder: 'Папка комплекта',
    packageFolder: 'Папка пакета'
  },
  inputs: {
    keyframeLabel: ({ label, approved }: { label: string; approved: boolean }) => `${label}${approved ? '' : ' · кандидат'}`,
    animaticCardLabel: ({ shot }: { shot: string }) => `Карточка аниматика · ${shot}`,
    acceptedRequest: 'Входы принятого запроса',
    packageKeyframes: 'Опоры пакета',
    openImage: ({ label }: { label: string }) => `Открыть изображение: ${label}`,
    animaticCard: 'Карточка аниматика',
    openAnimaticCard: ({ shot }: { shot: string }) => `Открыть карточку аниматика: ${shot}`,
    inputImage: 'Входное изображение'
  },
  prompt: { accepted: 'Промпт принятой генерации', package: 'Видеопромпт пакета', copy: 'Скопировать промпт' },
  staging: { title: 'Постановка', continuity: '{label} {continuity}', continuityLabel: 'Связь.' },
  state: {
    notComputed: ({ title }: { title: string }) => `${title}: не вычислено.`,
    missing: 'состояние не задано',
    checklist: ({ checklist }: { checklist: string }) => `Проверить по кадру: ${checklist}`
  },
  comparison: {
    failed: ({ reason }: { reason: string }) => `Не удалось включить синхронное сравнение: ${reason}`,
    mediaLoadFailed: 'Не удалось загрузить одно из видео.'
  },
  mediaEdit: {
    still: ({ time }: { time: string }) => `стоп-кадр оригинала на ${time} с`,
    interval: ({ start, end }: { start: string; end: string }) => `участок оригинала ${start}–${end} с`,
    wholeOriginal: 'оригинал целиком',
    speed: ({ speed }: { speed: string }) => `скорость ${speed}`,
    holdFirst: ({ duration }: { duration: string | number }) => `удержание первого кадра ${duration} с`,
    holdLast: ({ duration }: { duration: string | number }) => `удержание последнего кадра ${duration} с`,
    duration: ({ frames, duration }: { frames: number; duration: string }) => `${countLabel(frames, 'кадр', 'кадра', 'кадров')}, ${duration} с`,
    acceptedAndOriginal: 'Оригинал генерации и принятый монтаж',
    original: 'Оригинал генерации',
    accepted: commonTexts.media.acceptedEdit,
    missingFile: commonTexts.media.fileMissing,
    originalCaption: ({ media }: { media: string | null | undefined }) => `Оригинал${media ? ` · ${media}` : ''}`,
    acceptedCaption: ({ recipe }: { recipe: string }) => `Принятый монтаж · ${recipe}`,
    bothRequired: 'Для сравнения нужны оба видео: оригинал генерации и принятый монтаж.',
    loading: 'Дождитесь загрузки обоих видео.',
    pauseTogether: 'Приостановить синхронно',
    playTogether: 'Воспроизвести синхронно',
    unaccepted: 'Результат генерации (не принят)'
  }
} as const;
