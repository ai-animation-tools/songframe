import { describe, expect, it } from 'vitest';
import type { AssetEdit } from '@shared/types';
import { acceptedCaption } from './AcceptedAsset';

const edit = (overrides: Partial<AssetEdit> = {}): AssetEdit => ({
  fps: 30,
  frames: 102,
  duration: 3.4,
  sourceInterval: [0, 3.4],
  stillAt: null,
  speed: '1',
  holdFirst: 0,
  holdLast: 0,
  note: '',
  ...overrides
});
const size = { width: 1920, height: 1080 };

/** Подпись под принятым участком: тот же вид, что параметры оригинала; ожидания записаны словами. */
describe('подпись принятого участка', () => {
  it('называет размер, частоту, кадры, длину и участок оригинала', () => {
    expect(acceptedCaption(edit(), size)).toBe('1920×1080, 30/1 FPS, кадров: 102, 3.40 с · участок оригинала 0.00–3.40 с');
  });

  it('до загрузки видео размер неизвестен', () => {
    expect(acceptedCaption(edit({ fps: 24 }), null)).toBe('?×?, 24/1 FPS, кадров: 102, 3.40 с · участок оригинала 0.00–3.40 с');
  });

  it('называет стоп-кадр, целый оригинал, скорость и удержания', () => {
    expect(acceptedCaption(edit({ stillAt: 1.5 }), size)).toBe('1920×1080, 30/1 FPS, кадров: 102, 3.40 с · стоп-кадр оригинала на 1.50 с');
    expect(acceptedCaption(edit({ sourceInterval: null, speed: '1.25', holdFirst: 0.5, holdLast: 1 }), size)).toBe(
      '1920×1080, 30/1 FPS, кадров: 102, 3.40 с · оригинал целиком, скорость 1.25, удержание первого кадра 0.5 с, удержание последнего кадра 1 с'
    );
  });
});
