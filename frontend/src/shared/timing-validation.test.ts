import { describe, expect, it } from 'vitest';
import { hasMinimumTimingLength, validateTiming } from './timing-validation';
import type { TimingFile } from './types';

describe('минимальная длина строки разметки', () => {
  it('принимает 300 мс после ненулевого начала и отклоняет 299 мс без округления границ', () => {
    expect(hasMinimumTimingLength(2, 2.3)).toBe(true);
    expect(hasMinimumTimingLength(2, 2.299)).toBe(false);
    expect(hasMinimumTimingLength(Number.NaN, 2.3)).toBe(false);
    expect(hasMinimumTimingLength(2, Infinity)).toBe(false);
    expect(hasMinimumTimingLength(2.3, 2)).toBe(false);
    const timing: TimingFile = {
      version: 2,
      status: '',
      source: 'source/track.mp3',
      sha256: null,
      duration_decoded: 3,
      duration_container: 3,
      clock: '',
      lines: [{ id: 1, source_line: 1, start: 2, end: 2.3 }],
      sections: []
    };
    const lyrics = [{ number: 1, text: 'Короткий возглас', header: false }];
    expect(validateTiming(timing, lyrics, 3)).toEqual([]);
    expect(timing.lines[0]).toMatchObject({ start: 2, end: 2.3 });
    expect(validateTiming({ ...timing, lines: [{ ...timing.lines[0], end: 2.299 }] }, lyrics, 3)).toHaveLength(1);
  });
});
