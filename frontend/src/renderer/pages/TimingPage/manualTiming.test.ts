/** В сохранение попадают видимые поля, даже когда промежуточные значения не являются интервалом. */
import { describe, expect, it } from 'vitest';
import { validateTiming } from '@shared/timing-validation';
import { applyTimingBoundaryDrafts, parseTimingBoundary } from './manualTiming';
import { emptyTiming } from './timing';

const lines = [
  { id: 1, source_line: 2, start: 0, end: 2.9 },
  { id: 2, source_line: 3, start: 14, end: 18 }
];
const lyrics = [
  { number: 2, text: 'Первая строка', header: false },
  { number: 3, text: 'Вторая строка', header: false }
];

describe('сырой черновик ручных границ', () => {
  it.each(['', '  ', 'не время', 'Infinity'])('не подставляет ноль или прежнюю границу вместо %j', (raw) => {
    const result = applyTimingBoundaryDrafts(lines, { 1: { start: raw } });
    expect(Number.isFinite(result[0].start)).toBe(false);
    expect(validateTiming({ ...emptyTiming(30), lines: result }, lyrics, 30)).toContain('строка 1: границы не числа.');
    expect(lines[0].start).toBe(0);
  });
  it('принимает десятичную запятую без изменения сохранённого формата', () => {
    expect(parseTimingBoundary(' 12,125 ')).toBe(12.125);
    expect(parseTimingBoundary('-2.5')).toBe(-2.5);
  });
  it('сохраняет инверсию и пересечение до явной проверки, а исправление собирает точный интервал', () => {
    const drafts = { 1: { start: '12' } };
    const inverted = applyTimingBoundaryDrafts(lines, drafts);
    expect(inverted[0]).toMatchObject({ start: 12, end: 2.9 });
    const overlap = applyTimingBoundaryDrafts(inverted, { 1: { end: '16' } });
    expect(overlap[0]).toMatchObject({ start: 12, end: 16 });
    expect(validateTiming({ ...emptyTiming(30), lines: overlap }, lyrics, 30)).toContain('Строки 1 и 2 пересекаются.');
    const fixed = applyTimingBoundaryDrafts(overlap, { 2: { start: '17', end: '20' } });
    expect(validateTiming({ ...emptyTiming(30), lines: fixed }, lyrics, 30)).toEqual([]);
    expect(fixed.map(({ start, end }) => [start, end])).toEqual([
      [12, 16],
      [17, 20]
    ]);
    expect(drafts).toEqual({ 1: { start: '12' } });
  });
});
