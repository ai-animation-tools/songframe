import type { TimingFile, TimingLine } from '@shared/types';

export const MIN_LENGTH = 0.3;

export function emptyTiming(duration: number | null): TimingFile {
  return {
    version: 2,
    // eslint-disable-next-line no-restricted-syntax -- Сохраняемый статус timing.json относится к формату данных, а не к подписи интерфейса.
    status: 'Разметка вручную; подтверждено на слух 0 из 0 строк.',
    source: 'source/track.mp3',
    sha256: null,
    duration_decoded: duration,
    duration_container: duration,
    // eslint-disable-next-line no-restricted-syntax -- Описание шкалы сохраняется в timing.json; первое выделение UI-текстов не меняет формат данных.
    clock: 'Секунды от начала декодированного звука, не SMPTE',
    lines: [],
    sections: []
  };
}

/** Одинаковые границы не дают полям, мыши и горячим клавишам пересекать соседние строки. */
export function neighbours(id: number, list: TimingLine[], duration: number): { prevEnd: number; nextStart: number } {
  const sorted = [...list].sort((a, b) => a.start - b.start);
  const index = sorted.findIndex((line) => line.id === id);
  return { prevEnd: index > 0 ? sorted[index - 1].end : 0, nextStart: index < sorted.length - 1 ? sorted[index + 1].start : duration || Infinity };
}

export function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
