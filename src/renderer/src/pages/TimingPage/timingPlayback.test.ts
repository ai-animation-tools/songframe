import { expect, it } from 'vitest';
import type { TimingLine } from '@shared/types';
import { filterTimingLines, timingPlaybackBounds } from './timingPlayback';
const lines: TimingLine[] = [
  { id: 1, source_line: 2, start: 1, end: 2, verified: true },
  { id: 2, source_line: 3, start: 3, end: 4, verified: false }
];
it('фильтр меняет только представление и немедленно учитывает подтверждение', () => {
  expect(filterTimingLines(lines, 'verified')).toEqual([lines[0]]);
  expect(filterTimingLines(lines, 'unverified')).toEqual([lines[1]]);
  expect(
    filterTimingLines(
      lines.map((line) => ({ ...line, verified: true })),
      'unverified'
    )
  ).toEqual([]);
  expect(filterTimingLines(lines, 'all')).toEqual(lines);
  expect(lines).toHaveLength(2);
});
it.each([
  [NaN, 2],
  [0, Infinity],
  [3, 2],
  [-1, 2],
  [2, 2],
  [0, 31]
])('не проигрывает незавершённые границы %s..%s, не меняя черновик', (start, end) => {
  const line = { ...lines[0], start, end };
  expect(timingPlaybackBounds(line, 30)).toBeNull();
  expect(line.start).toBe(start);
  expect(line.end).toBe(end);
});
it('читает новые границы без привязки к соседям и допускает конец трека', () => {
  expect(timingPlaybackBounds({ ...lines[0], start: 12, end: 30 }, 30)).toEqual({ start: 12, end: 30 });
  expect(timingPlaybackBounds(undefined, 30)).toBeNull();
});
