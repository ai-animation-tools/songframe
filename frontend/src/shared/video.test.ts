/**
 * Браузер и сборщик должны одинаково разрешать последний кадр на половинной границе.
 * Частоты кадров сверяются со схемами проекта, которые встраивает проверка реестра
 * (internal/lintregistry/schemas).
 */
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { FRAME_RATES, secondsToFrames } from './video';

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
