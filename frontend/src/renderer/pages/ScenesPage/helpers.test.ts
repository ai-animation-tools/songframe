import { describe, expect, it } from 'vitest';
import type { DashboardShot } from '@shared/types';
import { getSceneVideoPath } from './helpers';

/** Предпросмотр показывает выбранный монтаж, а картинки пакета сохраняют статичную карточку. */
describe('источник видео карточки сцены', () => {
  const shot = (video: string | null, downloads: string[]): DashboardShot =>
    ({ asset: video ? { video } : null, package: { request: { downloads } } }) as DashboardShot;

  it('предпочитает принятый монтаж скачанной попытке', () => {
    expect(getSceneVideoPath(shot('/assets/accepted.mp4', ['/attempt/original.mp4']))).toBe('/assets/accepted.mp4');
  });

  it('находит видео среди загрузок и сохраняет статичный режим для изображений', () => {
    expect(getSceneVideoPath(shot(null, ['/attempt/first.png', '/attempt/original.MP4']))).toBe('/attempt/original.MP4');
    expect(getSceneVideoPath(shot(null, ['/attempt/first.png']))).toBeNull();
    expect(getSceneVideoPath({ asset: null, package: null } as DashboardShot)).toBeNull();
  });
});
