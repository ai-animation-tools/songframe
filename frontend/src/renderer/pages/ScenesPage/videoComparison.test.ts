import { describe, expect, it } from 'vitest';
import { mapAcceptedTime, parseComparisonSpeed, type VideoComparisonEdit } from './videoComparison';

const edit: VideoComparisonEdit = {
  frames: 348,
  duration: 11.6,
  sourceInterval: [1, 1 + 485 / 30],
  stillAt: null,
  speed: '485/348',
  holdFirst: 0,
  holdLast: 0,
  note: ''
};

describe('сопоставление монтажа с оригиналом', () => {
  it('учитывает обрезку первой секунды и точную скорость 485/348', () => {
    expect(mapAcceptedTime(edit, 0, 20, 11.6)).toMatchObject({ sourceTime: 1, frozen: false });
    expect(mapAcceptedTime(edit, 2, 20, 11.6).sourceTime).toBeCloseTo(1 + (2 * 485) / 348);
    expect(mapAcceptedTime(edit, 2, 20, 11.6).playbackRate).toBeCloseTo(485 / 348);
  });

  it('удерживает первый и последний кадры во время добавленных пауз', () => {
    const held = { ...edit, frames: 120, duration: 4, sourceInterval: [1, 3] as [number, number], speed: '1', holdFirst: 0.5, holdLast: 1.5 };
    expect(mapAcceptedTime(held, 0.25, 5, 4)).toMatchObject({ sourceTime: 1, frozen: true });
    expect(mapAcceptedTime(held, 1, 5, 4)).toMatchObject({ sourceTime: 1.5, frozen: false });
    expect(mapAcceptedTime(held, 2.5, 5, 4).sourceTime).toBeCloseTo(3 - 1 / 30);
    expect(mapAcceptedTime(held, 3.8, 5, 4).frozen).toBe(true);
  });

  it('оставляет стоп-кадр неизменным на всём протяжении монтажа', () => {
    const still = { ...edit, stillAt: 2.25 };
    for (const time of [0, 1, 5, 11.6]) expect(mapAcceptedTime(still, time, 20, 11.6)).toMatchObject({ sourceTime: 2.25, frozen: true });
  });

  it('ограничивает конец последним кадром интервала и длительностью оригинала', () => {
    expect(mapAcceptedTime(edit, 100, 20, 11.6).sourceTime).toBeCloseTo(1 + 484 / 30);
    expect(mapAcceptedTime(edit, 100, 5, 11.6).sourceTime).toBeCloseTo(5 - 1 / 30);
  });

  it('подставляет скорость 1 и начало 0 при отсутствии рецепта обрезки', () => {
    const plain = { ...edit, speed: '', sourceInterval: null };
    expect(mapAcceptedTime(plain, 2, 20, 11.6)).toMatchObject({ sourceTime: 2, playbackRate: 1, frozen: false });
    for (const speed of ['0', '-2', 'NaN', '1/0', '1/2/3']) expect(parseComparisonSpeed(speed)).toBe(1);
    expect(parseComparisonSpeed('0.5')).toBe(0.5);
  });
});
