import { describe, expect, it } from 'vitest';
import type { TimingLine } from '@shared/types';
import { hitTimingBlock, timingDragPatch, timingWaveLayout } from './timingWaveGeometry';

const line = (id: number, start: number, end: number): TimingLine => ({ id, source_line: id + 1, start, end, verified: false, note: '' });

describe('геометрия ручной разметки', () => {
  it('разносит пересечения и даёт выбрать каждый блок независимо от порядка массива и выделения', () => {
    const lines = [line(3, 2, 6), line(1, 1, 5), line(2, 3, 7)];
    const layout = timingWaveLayout(lines, 48, true);
    expect(new Set(layout.blocks.map((block) => block.lane)).size).toBe(3);
    for (const block of layout.blocks) {
      const hit = hitTimingBlock(layout, 4 * 48, block.top + block.height / 2);
      expect(hit?.line.id).toBe(block.line.id);
      expect(hit?.mode).toBe('move');
    }
    expect(timingWaveLayout([...lines].reverse(), 48, true)).toEqual(layout);
    expect(layout.canvasHeight).toBeGreaterThan(154);
  });

  it('сохраняет обе ручки нулевых и инвертированных интервалов при любом масштабе', () => {
    for (const pps of [8, 48, 400]) {
      const layout = timingWaveLayout([line(1, 3, 3), line(2, 4, 2)], pps, true);
      expect(layout.blocks).toHaveLength(2);
      for (const block of layout.blocks) {
        expect(block.right - block.left).toBeGreaterThanOrEqual(20);
        const y = block.top + 10;
        expect(hitTimingBlock(layout, block.startX, y)).toMatchObject({ line: { id: block.line.id }, mode: 'start' });
        expect(hitTimingBlock(layout, block.endX, y)).toMatchObject({ line: { id: block.line.id }, mode: 'end' });
      }
    }
  });

  it('не передаёт NaN и Infinity в координаты canvas', () => {
    const layout = timingWaveLayout([line(1, NaN, 5), line(2, 3, Infinity), line(3, 1, 2), line(4, -2e307, 2e307)], 48, true);
    expect(layout.blocks.map((block) => block.line.id)).toEqual([3]);
    expect(hitTimingBlock(layout, 1.5 * 48, 30)?.line.id).toBe(3);
    expect(timingWaveLayout([line(1, 1, 2)], Infinity, true).blocks).toEqual([]);
  });

  it('учитывает пиксельные ручки соседей при распределении дорожек', () => {
    const layout = timingWaveLayout([line(1, 1, 1), line(2, 1.1, 1.1)], 8, true);
    expect(layout.blocks[0].lane).not.toBe(layout.blocks[1].lane);
  });
});

describe('перетаскивание ручного черновика', () => {
  const first = line(1, 1, 5);
  const lines = [first, line(2, 6, 9), line(3, 10, 11)];

  it('переносит строку через несколько соседей с сохранением длины', () => {
    expect(timingDragPatch(first, 'move', 13, 1, lines, 30, true)).toEqual({ start: 12, end: 16 });
    expect(timingDragPatch(first, 'move', 29, 1, lines, 30, true)).toEqual({ start: 26, end: 30 });
  });

  it('разрешает изменить конец через соседей и начало через собственный конец', () => {
    expect(timingDragPatch(first, 'end', 16, 0, lines, 30, true)).toEqual({ end: 16 });
    expect(timingDragPatch(first, 'start', 8, 0, lines, 30, true)).toEqual({ start: 8 });
    expect(timingDragPatch(first, 'end', 1, 0, lines, 30, true)).toEqual({ end: 1 });
  });

  it('перемещает расширенные ручки коротких, нулевых и обратных интервалов ровно на дельту мыши', () => {
    for (const pps of [8, 48]) {
      for (const original of [line(1, 3, 3.05), line(1, 3, 3), line(1, 3.05, 3), line(1, 0, 0)]) {
        const layout = timingWaveLayout([original], pps, true);
        const block = layout.blocks[0];
        expect(block.left).toBeGreaterThanOrEqual(0);
        for (const mode of ['start', 'end'] as const) {
          const capturedTime = (mode === 'start' ? block.startX : block.endX) / pps;
          const offset = capturedTime - original[mode];
          expect(hitTimingBlock(layout, capturedTime * pps, block.top + 10)?.mode).toBe(mode);
          expect(timingDragPatch(original, mode, capturedTime, offset, [original], 30, true)).toEqual({ [mode]: original[mode] });
          const expected = Math.round((original[mode] + 1 / pps) * 1000) / 1000;
          expect(timingDragPatch(original, mode, capturedTime + 1 / pps, offset, [original], 30, true)).toEqual({ [mode]: expected });
        }
      }
    }
  });

  it('захватывает середину расширенного блока без скрытого сдвига времени', () => {
    for (const pps of [8, 48]) {
      for (const original of [line(1, 3, 3.05), line(1, 3, 3), line(1, 3.05, 3), line(1, 0, 0)]) {
        const layout = timingWaveLayout([original], pps, true);
        const block = layout.blocks[0];
        const capturedTime = (block.left + block.right) / 2 / pps;
        const offset = capturedTime - original.start;
        expect(hitTimingBlock(layout, capturedTime * pps, block.top + 10)?.mode).toBe('move');
        expect(timingDragPatch(original, 'move', capturedTime, offset, [original], 30, true)).toEqual({ start: original.start, end: original.end });
      }
    }
  });

  it('после компенсации захвата ограничивает resize треком, а в обычном режиме — соседями', () => {
    expect(timingDragPatch(first, 'start', 1, 2, lines, 30, true)).toEqual({ start: 0 });
    expect(timingDragPatch(first, 'end', 31, -2, lines, 30, true)).toEqual({ end: 30 });
    expect(timingDragPatch(first, 'end', 7, 2, lines, 30)).toEqual({ end: 5 });
    expect(timingDragPatch(first, 'end', 11, 2, lines, 30)).toEqual({ end: 6 });
  });

  it('переносит обратный интервал без скрытого исправления порядка границ', () => {
    const inverse = line(1, 5, 1);
    expect(timingDragPatch(inverse, 'move', 2, 1, [inverse], 30, true)).toEqual({ start: 4, end: 0 });
    expect(timingDragPatch(inverse, 'move', 17, 1, [inverse], 30, true)).toEqual({ start: 16, end: 12 });
  });

  it('сохраняет прежние ограничения обычного режима', () => {
    expect(timingDragPatch(first, 'move', 13, 1, lines, 30)).toEqual({ start: 2, end: 6 });
    expect(timingDragPatch(first, 'end', 16, 0, lines, 30)).toEqual({ end: 6 });
    expect(timingDragPatch(first, 'start', 8, 0, lines, 30)).toEqual({ start: 4.7 });
  });

  it('пропускает нечисловой перенос и позволяет восстановить одну известную границу', () => {
    expect(timingDragPatch(first, 'move', NaN, 1, lines, 30, true)).toBeNull();
    const invalid = line(1, NaN, 4);
    expect(timingDragPatch(invalid, 'move', 5, 1, [invalid], 30, true)).toBeNull();
    expect(timingDragPatch(invalid, 'start', 2, 0, [invalid], 30, true)).toEqual({ start: 2 });
  });
});
