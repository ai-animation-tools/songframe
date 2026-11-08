/** Прослушивание проверяет только выбранный интервал и не нормализует свободный черновик редактора. */
import type { TimingLine } from '@shared/types';
export function timingPlaybackBounds(line: TimingLine | undefined, duration: number): { start: number; end: number } | null {
  if (
    !line ||
    !Number.isFinite(line.start) ||
    !Number.isFinite(line.end) ||
    line.start < 0 ||
    line.end <= line.start ||
    (duration > 0 && line.end > duration + 0.001)
  )
    return null;
  return { start: line.start, end: duration > 0 ? Math.min(line.end, duration) : line.end };
}
export type TimingLineFilter = 'all' | 'verified' | 'unverified';
/** Фильтр меняет только представление: скрытые строки остаются в черновике и расчёте соседей. */
export function filterTimingLines(lines: TimingLine[], filter: TimingLineFilter): TimingLine[] {
  return filter === 'all' ? lines : lines.filter((line) => Boolean(line.verified) === (filter === 'verified'));
}
