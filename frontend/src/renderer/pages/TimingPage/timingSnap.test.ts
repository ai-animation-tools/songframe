import { describe, expect, it } from 'vitest';
import type { TimingLine } from '@shared/types';
import { TIMING_SNAP_PIXELS, timingSnap, timingSnapTargets } from './timingSnap';

const line = (id: number, start: number, end: number): TimingLine => ({ id, source_line: id, start, end });

describe('прилипание на шкале таймингов', () => {
  it('целями служат границы других строк и плейхед', () => {
    expect(timingSnapTargets([line(1, 1, 2), line(2, 3, 4), line(3, Number.NaN, 5)], [2], 7.5)).toEqual([1, 2, 5, 7.5]);
    expect(timingSnapTargets([line(1, 1, 2)], [], null)).toEqual([1, 2]);
  });

  it('притягивает ближайшую границу в пределах экранного порога', () => {
    const pps = 100;
    expect(timingSnap([2.03], [2, 2.5], pps)).toEqual({ shift: expect.closeTo(-0.03, 6), guide: 2 });
    // Перенос строки: ближе цель у конца, сдвиг общий.
    expect(timingSnap([1.2, 2.47], [1, 2.5], pps)).toEqual({ shift: expect.closeTo(0.03, 6), guide: 2.5 });
  });

  it('за порогом и без масштаба не притягивает', () => {
    expect(timingSnap([2 + (TIMING_SNAP_PIXELS + 1) / 100], [2], 100)).toBeNull();
    expect(timingSnap([2], [2], 0)).toBeNull();
    // Тот же зазор в секундах прилипает при более мелком масштабе: порог задан в пикселях.
    expect(timingSnap([2.1], [2], 50)).toEqual({ shift: expect.closeTo(-0.1, 6), guide: 2 });
  });
});
