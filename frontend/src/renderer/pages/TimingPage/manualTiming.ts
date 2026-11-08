/** Сырые поля живут отдельно от числовой геометрии: пустой или незаконченный ввод не подменяется прежней границей. */
import type { TimingLine } from '@shared/types';

export type TimingBoundaryDrafts = Record<number, Partial<Record<'start' | 'end', string>>>;

export function parseTimingBoundary(text: string): number {
  const value = text.trim().replace(',', '.');
  return value ? Number(value) : Number.NaN;
}

/** Сохранение собирает именно видимые поля, включая пустые и нечисловые, а не последнюю допустимую геометрию. */
export function applyTimingBoundaryDrafts(lines: TimingLine[], drafts: TimingBoundaryDrafts): TimingLine[] {
  return lines.map((line) => {
    const draft = drafts[line.id];
    return draft
      ? {
          ...line,
          start: draft.start === undefined ? line.start : parseTimingBoundary(draft.start),
          end: draft.end === undefined ? line.end : parseTimingBoundary(draft.end)
        }
      : line;
  });
}
