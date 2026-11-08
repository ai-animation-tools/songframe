import { describe, expect, it } from 'vitest';
import { derivedShotTexts as texts } from './derived-shot';

/** Проверяем все счётчики рецепта: подпись формы и готовый предпросмотр используют один словарь. */
describe('числовые формы производного плана', () => {
  it.each([
    [0, 'кадров'],
    [1, 'кадр'],
    [2, 'кадра'],
    [3, 'кадра'],
    [4, 'кадра'],
    [5, 'кадров'],
    [11, 'кадров'],
    [12, 'кадров'],
    [13, 'кадров'],
    [14, 'кадров'],
    [21, 'кадр'],
    [22, 'кадра'],
    [23, 'кадра'],
    [24, 'кадра'],
    [101, 'кадр'],
    [111, 'кадров']
  ] as const)('согласует %s кадров во всех режимах', (count, word) => {
    const label = `${count} ${word}`;
    expect(texts.sourceFrames({ frames: count })).toBe(`Источник: ${label} · ${(count / 30).toFixed(3)} с · 30 FPS`);
    expect(texts.targetFrames({ frames: count })).toBe(`Цель: ${label} · ${(count / 30).toFixed(3)} с · 30 FPS`);
    expect(texts.trimInfo({ start: 0, end: count, frames: count })).toBe(`Кадры [0, ${count}) без изменения скорости → ${label}.`);
    expect(texts.fitInfo({ length: count, frames: count, speed: '1.000' })).toBe(`Участок: ${label} → ${label}; скорость 1.000×.`);
    expect(texts.repeatInfo({ length: count, cycles: 3, rest: count, frames: count })).toBe(
      `Участок: ${label}; полных повторов 3, затем ${label} участка → ${label}.`
    );
    expect(texts.stillInfo({ frame: 21, frames: count })).toBe(`Кадр 21 удерживается ${label} без движения.`);
  });
  it('исправляет пример предпросмотра с двумя кадрами хвоста', () => {
    expect(texts.repeatInfo({ length: 7, cycles: 34, rest: 2, frames: 240 })).toBe(
      'Участок: 7 кадров; полных повторов 34, затем 2 кадра участка → 240 кадров.'
    );
  });
});
