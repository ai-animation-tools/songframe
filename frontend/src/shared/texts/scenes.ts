import { commonTexts } from './common';

import { countLabel } from '../plural';

/** Тексты страницы «Планы» и принятого монтажа; правила текстов описаны в @link ../../../docs/ui/texts.md. */
export const scenesTexts = {
  montageSelected: ({ count }: { count: number }) => `Монтаж выбранных (${count})`,
  selectForMontage: 'Отметьте планы флажком «В монтажную пробу».',
  noVisibleScenes: 'Нет видимых планов: измените фильтр или поиск.',
  markVisible: 'Отметить видимые',
  noMarkedScenes: 'Нет отмеченных планов.',
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
  staging: { title: 'Постановка', continuity: '{label} {continuity}', continuityLabel: 'Связь.' },
  state: {
    notComputed: ({ title }: { title: string }) => `${title}: не вычислено.`,
    missing: 'состояние не задано',
    checklist: ({ checklist }: { checklist: string }) => `Проверить по кадру: ${checklist}`
  }
} as const;
