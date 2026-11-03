/**
 * Браузер и сборщик должны одинаково разрешать последний кадр на половинной границе.
 * Отличие от 634fd94: сверка FPS со схемами Python tools/lint_registry убрана — схем в Go-репозитории
 * нет; частоту кадров контракта проекта проверяют Go-тесты и эталоны testdata/golden.
 */
import { describe, expect, it } from 'vitest';
import { secondsToFrames } from './video';

describe('сетка кадров build_review', () => {
  it('совпадает с Decimal ROUND_HALF_UP для длительностей ffprobe', () => {
    expect(secondsToFrames(Number('2.050000'))).toBe(62);
    expect(secondsToFrames(Number('2.049999'))).toBe(61);
    expect(secondsToFrames(Number('2.050001'))).toBe(62);
    expect(secondsToFrames(Number('0.350000'))).toBe(11);
  });
});
