import { describe, expect, it } from 'vitest';
import type { TimingLine } from '@shared/types';
import { MIN_LENGTH } from './timing';
import { timingJoinBounds, timingPair, timingPairPatch, timingSelectionBounds, timingZoomBounds } from './timingSelection';

const line = (id: number, start: number, end: number, verified = false): TimingLine => ({ id, source_line: id, start, end, verified });

describe('выделение соседней пары', () => {
  it('определяет соседей по времени среди всех валидных строк и не меняет массив', () => {
    const lines = [line(9, 4, 6), line(4, 2, 4), line(2, 0, 2), line(5, 3, 3)];
    expect(timingPair(lines, [9, 4])).toMatchObject({ first: { id: 4 }, second: { id: 9 }, join: 4, gap: 0, locked: false });
    expect(timingPair(lines, [2, 9])).toBeNull();
    expect(lines.map((item) => item.id)).toEqual([9, 4, 2, 5]);
  });

  it('использует id при одинаковом начале и учитывает скрытую подтверждённую строку', () => {
    const lines = [line(3, 1, 3), line(2, 1, 2, true), line(1, 0, 1)];
    expect(timingPair(lines, [1, 3])).toBeNull();
    expect(timingPair(lines, [3, 2])).toMatchObject({ first: { id: 2 }, second: { id: 3 }, locked: true, join: null, gap: -1 });
  });

  it.each([[], [1], [1, 1], [1, 2, 3], [1, 8]])('отклоняет неполный или неоднозначный выбор %s', (...ids) => {
    expect(timingPair([line(1, 0, 1), line(2, 1, 2)], ids)).toBeNull();
  });

  it.each([
    [NaN, 3],
    [1, Infinity],
    [3, 2],
    [-1, 2],
    [2, 2]
  ])('не нормализует некорректную строку %s..%s', (start, end) => {
    const invalid = line(2, start, end);
    expect(timingPair([line(1, 0, 1), invalid], [1, 2])).toBeNull();
    expect(invalid).toMatchObject({ start, end });
  });

  it.each([0, 0.001, -0.001, 0.0005])('считает стыком зазор в пределах миллисекунды: %s', (gap) => {
    const pair = timingPair([line(1, 0, 2), line(2, 2 + gap, 4)], [1, 2]);
    expect(pair?.join).toBeCloseTo(2 + gap / 2, 10);
    expect(pair?.gap).toBeCloseTo(gap, 10);
  });

  it.each([0.002, -0.002, 1, -1])('сохраняет разрыв или перекрытие без выдуманного стыка: %s', (gap) => {
    const pair = timingPair([line(1, 0, 2), line(2, 2 + gap, 4)], [1, 2]);
    expect(pair?.join).toBeNull();
    expect(pair?.gap).toBeCloseTo(gap, 10);
  });
});

describe('правка общей границы', () => {
  it.each([2, 3])('явно соединяет разрыв и перекрытие с сохранением внешних краёв: %s', (start) => {
    const lines = [line(1, 1, 2.5), line(2, start, 5)];
    const pair = timingPair(lines, [1, 2])!;
    expect(timingPairPatch(pair, 2.34567, 10)).toEqual([
      { id: 1, patch: { end: 2.346 } },
      { id: 2, patch: { start: 2.346 } }
    ]);
    expect(lines.map((item) => [item.start, item.end])).toEqual([
      [1, 2.5],
      [start, 5]
    ]);
  });

  it('ограничивает движение минимальной длиной каждой строки с округлением внутрь', () => {
    const pair = timingPair([line(1, 0.0004, 1), line(2, 1, 2.0004)], [1, 2])!;
    for (const [time, expected] of [
      [-10, 0.301],
      [10, 1.7]
    ]) {
      const patch = timingPairPatch(pair, time, 3)!;
      const join = patch[0].patch.end!;
      expect(join).toBe(expected);
      expect(join - pair.first.start).toBeGreaterThanOrEqual(MIN_LENGTH);
      expect(pair.second.end - join).toBeGreaterThanOrEqual(MIN_LENGTH);
    }
  });

  it('сохраняет общий стык двух строк ровно по 300 мс после ненулевого начала', () => {
    const pair = timingPair([line(1, 2, 2.3), line(2, 2.3, 2.6)], [1, 2])!;
    expect(timingPairPatch(pair, 2.3, 3)).toEqual([
      { id: 1, patch: { end: 2.3 } },
      { id: 2, patch: { start: 2.3 } }
    ]);
  });

  it('не правит закреплённые строки, неверные границы и слишком короткую пару', () => {
    const pair = timingPair([line(1, 0, 1), line(2, 1, 2)], [1, 2])!;
    expect(timingPairPatch({ ...pair, first: { ...pair.first, verified: true } }, 1.2, 3)).toBeNull();
    expect(timingPairPatch({ ...pair, second: { ...pair.second, verified: true } }, 1.2, 3)).toBeNull();
    expect(timingPairPatch({ ...pair, locked: true }, 1.2, 3)).toBeNull();
    expect(timingPairPatch(pair, NaN, 3)).toBeNull();
    expect(timingPairPatch(pair, 1, 1.9)).toBeNull();
    expect(timingPairPatch({ ...pair, first: { ...pair.first, start: NaN } }, 1, 3)).toBeNull();
    expect(timingPairPatch(timingPair([line(1, 0, 0.2), line(2, 0.2, 0.5)], [1, 2])!, 0.2, 3)).toBeNull();
  });
});

describe('прослушивание выделения и стыка', () => {
  const lines = [line(1, 1, 3, true), line(2, 4, 7)];

  it('берёт внешние края, сохраняя разрыв и включая подтверждённые строки', () => {
    expect(timingSelectionBounds(lines, [2, 1], 10)).toEqual({ start: 1, end: 7 });
    expect(timingSelectionBounds(lines, [1], 10)).toEqual({ start: 1, end: 3 });
    expect(timingSelectionBounds(lines, [2], 0)).toEqual({ start: 4, end: 7 });
  });

  it('не запускает частичное выделение при ошибке одной из строк', () => {
    expect(timingSelectionBounds(lines, [], 10)).toBeNull();
    expect(timingSelectionBounds(lines, [1, 1], 10)).toBeNull();
    expect(timingSelectionBounds(lines, [1, 8], 10)).toBeNull();
    expect(timingSelectionBounds(lines, [1, 2], 6)).toBeNull();
    expect(timingSelectionBounds([lines[0], line(2, 5, 4)], [1, 2], 10)).toBeNull();
  });

  it('ограничивает окно стыка треком, но допускает его прослушивание при блокировке', () => {
    expect(timingJoinBounds(timingPair([line(1, 0, 0.4, true), line(2, 0.4, 1)], [1, 2])!, 1)).toEqual({ start: 0, end: 1 });
    expect(timingJoinBounds(timingPair([line(1, 0, 2), line(2, 2, 4)], [1, 2])!, 5, 0.5)).toEqual({ start: 1.5, end: 2.5 });
    expect(timingJoinBounds(timingPair(lines, [1, 2])!, 10)).toBeNull();
  });
});

describe('масштаб выделения', () => {
  it('помещает выделение с полями и вычисляет прокрутку', () => {
    expect(timingZoomBounds({ start: 10, end: 20 }, 600, 100)).toEqual({ pps: 50, scrollLeft: 450 });
    expect(timingZoomBounds({ start: 0, end: 100 }, 600, 100)).toEqual({ pps: 6, scrollLeft: 0 });
    expect(timingZoomBounds({ start: 90, end: 100 }, 550, 100)).toEqual({ pps: 50, scrollLeft: 4450 });
  });

  it('ограничивает верхний масштаб и не требует минимальных восьми пикселей в секунду', () => {
    expect(timingZoomBounds({ start: 20, end: 20.1 }, 600, 100)).toMatchObject({ pps: 400 });
    expect(timingZoomBounds({ start: 0, end: 3600 }, 720, 3600)).toEqual({ pps: 0.2, scrollLeft: 0 });
  });

  it.each([
    [NaN, 2, 600, 10],
    [2, 2, 600, 10],
    [-1, 2, 600, 10],
    [1, 11, 600, 10],
    [1, 2, 0, 10],
    [1, 2, 600, 0],
    [1, 2, Infinity, 10]
  ])('не рассчитывает масштаб для некорректных параметров %s..%s/%s/%s', (start, end, width, duration) => {
    expect(timingZoomBounds({ start, end }, width, duration)).toBeNull();
  });
});
