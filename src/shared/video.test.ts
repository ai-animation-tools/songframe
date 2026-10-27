/** Браузер и сборщик должны одинаково разрешать последний кадр на половинной границе. */
import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FPS, secondsToFrames } from './video';

describe('сетка кадров build_review', () => {
  it('совпадает с поддерживаемой частотой реестра и принятых комплектов', () => {
    const schema = (name: string): { properties: Record<string, { const?: number; properties?: Record<string, { const?: number }> }> } =>
      JSON.parse(readFileSync(resolve('tools/lint_registry/schemas', `${name}.schema.json`), 'utf8'));
    expect(schema('scenes').properties.fps.const).toBe(FPS);
    expect(schema('manifest').properties.accepted_edit.properties?.fps.const).toBe(FPS);
  });
  it('совпадает с Decimal ROUND_HALF_UP для длительностей ffprobe', () => {
    expect(secondsToFrames(Number('2.050000'))).toBe(62);
    expect(secondsToFrames(Number('2.049999'))).toBe(61);
    expect(secondsToFrames(Number('2.050001'))).toBe(62);
    expect(secondsToFrames(Number('0.350000'))).toBe(11);
  });
});
