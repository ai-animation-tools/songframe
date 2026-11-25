/**
 * Браузер и сборщик должны одинаково разрешать последний кадр на половинной границе.
 * Частоты кадров сверяются со схемами проекта, которые встраивает проверка реестра
 * (internal/lintregistry/schemas).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { cutFrameOf, cutResultFrames, cutSeconds, fitCutEnd, FRAME_RATES, secondsToFrames } from './video';

describe('сетка кадров build_review', () => {
  it('совпадает с допустимыми частотами реестра и принятых комплектов', () => {
    const schema = (name: string): { properties: Record<string, { enum?: number[]; properties?: Record<string, { enum?: number[] }> }> } =>
      JSON.parse(readFileSync(resolve(__dirname, '../../../internal/lintregistry/schemas', `${name}.schema.json`), 'utf8'));
    expect(schema('scenes').properties.fps.enum).toEqual([...FRAME_RATES]);
    expect(schema('manifest').properties.accepted_edit.properties?.fps.enum).toEqual([...FRAME_RATES]);
  });
  it('совпадает с Decimal ROUND_HALF_UP для длительностей ffprobe', () => {
    expect(secondsToFrames(Number('2.050000'), 30)).toBe(62);
    expect(secondsToFrames(Number('2.049999'), 30)).toBe(61);
    expect(secondsToFrames(Number('2.050001'), 30)).toBe(62);
    expect(secondsToFrames(Number('0.350000'), 30)).toBe(11);
    expect(secondsToFrames(Number('1.020833'), 24)).toBe(24);
    expect(secondsToFrames(Number('0.020000'), 25)).toBe(1);
  });
});

describe('граница монтажного участка', () => {
  it('секунды кадра до тысячных приводятся к кадру, граница между кадрами — нет', () => {
    expect(cutFrameOf(0.833, 30)).toBe(25);
    expect(cutFrameOf(5.167, 30)).toBe(155);
    expect(cutFrameOf(0.042, 24)).toBe(1);
    expect(cutFrameOf(0.8333333333333334, 30)).toBe(25);
    expect(cutFrameOf(0.875, 30)).toBeNull();
    expect(cutFrameOf(0.8325, 30)).toBeNull();
    expect(cutFrameOf(-1, 30)).toBeNull();
  });
  it('секунды кадра для поля — до тысячных и снова дают тот же кадр', () => {
    for (const fps of FRAME_RATES) for (let frame = 0; frame < 400; frame++) expect(cutFrameOf(cutSeconds(frame, fps), fps)).toBe(frame);
    expect(cutSeconds(155, 30)).toBe(5.167);
  });
});

describe('длина принятого участка', () => {
  it('считается как в build_review: частное скорости с округлением половины вверх и удержания', () => {
    // 181 кадр при скорости 1,153 — 156,98 → 157 (окно M29 клипа 01).
    expect(cutResultFrames(0, 181, '1.153')).toBe(157);
    expect(cutResultFrames(0, 181, '1,153')).toBe(157);
    expect(cutResultFrames(0, 120, '1')).toBe(120);
    expect(cutResultFrames(30, 120, '0.8')).toBe(113); // 112,5 → 113: половина вверх
    expect(cutResultFrames(0, 5, '2')).toBe(3); // 2,5 → 3
    expect(cutResultFrames(0, 7, '2')).toBe(4); // 3,5 → 4
    expect(cutResultFrames(0, 10, '3')).toBe(3); // 3,33 → 3
    expect(cutResultFrames(0, 100, '1', 2, 5)).toBe(107);
  });

  it('не считает неверный участок, скорость и удержание', () => {
    expect(cutResultFrames(null, 181, '1')).toBeNull();
    expect(cutResultFrames(10, 10, '1')).toBeNull();
    expect(cutResultFrames(0, 181, '')).toBeNull();
    expect(cutResultFrames(0, 181, '0')).toBeNull();
    expect(cutResultFrames(0, 181, '-1')).toBeNull();
    expect(cutResultFrames(0, 181, '1.2.3')).toBeNull();
    expect(cutResultFrames(0, 181, '1', -1)).toBeNull();
    expect(cutResultFrames(0, 181, '1', 0, 1.5)).toBeNull();
    expect(cutResultFrames(0, 1, '4')).toBeNull(); // 0,25 → 0: движение короче кадра
  });
});

describe('конец участка под окно', () => {
  it('даёт окно при скорости и удержаниях, как считает build_review', () => {
    // Окно 279 кадров при скорости 0,9: отрезок 251 кадр (251 / 0,9 = 278,9 → 279).
    expect(fitCutEnd(0, '0.9', 279)).toEqual({ endFrame: 251, frames: 279 });
    expect(fitCutEnd(0, '0,9', 279, 0, 0, 300)).toEqual({ endFrame: 251, frames: 279 });
    expect(fitCutEnd(30, '1', 120, 10, 5)).toEqual({ endFrame: 135, frames: 120 });
    expect(fitCutEnd(0, '1.153', 157)).toMatchObject({ frames: 157 });
    for (const speed of ['0.8', '1.25', '2', '3']) {
      const fit = fitCutEnd(12, speed, 200, 7, 3);
      expect(fit).toMatchObject({ frames: 200 });
      if ('endFrame' in fit) expect(cutResultFrames(12, fit.endFrame, speed, 7, 3)).toBe(200);
    }
  });

  it('при скорости меньше 1 без точного совпадения берёт ближайшую меньшую длину', () => {
    // При скорости 0,5 каждый кадр отрезка — два кадра плана: 101 кадр не набрать.
    expect(fitCutEnd(0, '0.5', 101)).toEqual({ endFrame: 50, frames: 100 });
    // 180 / 0,95 = 189,47 → 189, 181 / 0,95 = 190,53 → 191: 190 кадров движения не набрать.
    expect(fitCutEnd(12, '0.95', 200, 7, 3)).toEqual({ endFrame: 192, frames: 199 });
  });

  it('объясняет, почему конец не подобрать', () => {
    expect(fitCutEnd(0, '0.9', 279, 0, 0, 240)).toEqual({ reason: 'originalTooShort', neededFrames: 251 });
    expect(fitCutEnd(0, '1', 30, 20, 10)).toEqual({ reason: 'holdsTooLong' });
    expect(fitCutEnd(null, '1', 30)).toEqual({ reason: 'invalid' });
    expect(fitCutEnd(0, '0', 30)).toEqual({ reason: 'invalid' });
    expect(fitCutEnd(0, '1', 30, 1.5)).toEqual({ reason: 'invalid' });
  });
});
