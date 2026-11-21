/** Изображение карточки плана: первая опора комплекта, иначе материалы последнего пакета; видео не показывается. */
import { describe, expect, it } from 'vitest';
import type { PackageView, ShotProduction } from '@shared/types';
import { shotImage } from './preview';

function pkg(overrides: Partial<PackageView>): PackageView {
  return {
    dir: '/p',
    relative: 'batches/M45-attempt-01',
    shot: 'M45',
    stage: 'downloaded',
    stageLabel: '',
    waitReason: null,
    mode: null,
    retryOf: null,
    batch: null,
    timing: null,
    keyframes: [],
    description: null,
    prompt: null,
    request: null,
    ...overrides
  } as PackageView;
}

function shot(overrides: Partial<ShotProduction>): ShotProduction {
  return {
    id: 'M45',
    title: 'План',
    original: '',
    start: 0,
    end: 5,
    lipsync: false,
    state: 'progress',
    stageLabel: '',
    regenerateProblem: null,
    derivedFrom: null,
    attention: null,
    asset: null,
    packages: [],
    ...overrides
  };
}

describe('shotImage', () => {
  const first = pkg({ keyframes: [{ id: 'K01', role: 'first', time_seconds: 0, imagePath: '/old.png', approved: true }] });
  const last = pkg({ keyframes: [{ id: 'K01', role: 'first', time_seconds: 0, imagePath: '/new.png', approved: false }] });

  it('у принятого плана берёт первую опору из папки комплекта', () => {
    expect(shotImage(shot({ asset: { dir: '/a', video: '/a/video.mp4', original: null, frame: '/a/generation-input-1.png' }, packages: [first, last] }))).toBe(
      '/a/generation-input-1.png'
    );
  });

  it('без опоры в комплекте берёт первую опору последней попытки', () => {
    expect(shotImage(shot({ asset: { dir: '/a', video: '/a/video.mp4', original: null, frame: null }, packages: [first, last] }))).toBe('/new.png');
  });

  it('без опор берёт скачанное изображение, видео не берёт', () => {
    const request = { downloads: ['/r/result.mp4', '/r/sheet.png'] } as unknown as PackageView['request'];
    expect(shotImage(shot({ packages: [pkg({ request })] }))).toBe('/r/sheet.png');
  });

  it('без материалов возвращает заглушку', () => {
    expect(shotImage(shot({}))).toBeNull();
  });
});
