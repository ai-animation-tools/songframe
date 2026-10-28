/** Предпросмотр карточки плана берёт принятое видео, иначе материалы последнего пакета. */
import { describe, expect, it } from 'vitest';
import type { PackageView, ShotProduction } from '@shared/types';
import { shotPreview } from './preview';

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
    attention: null,
    asset: null,
    packages: [],
    ...overrides
  };
}

describe('shotPreview', () => {
  it('предпочитает принятое видео и постер из опор последнего пакета', () => {
    const first = pkg({ keyframes: [{ id: 'f1', role: 'first', time_seconds: 0, imagePath: '/old.png', approved: true }] });
    const last = pkg({ keyframes: [{ id: 'f1', role: 'first', time_seconds: 0, imagePath: '/new.png', approved: false }] });
    expect(shotPreview(shot({ asset: { dir: '/a', video: '/a/video.mp4', original: null }, packages: [first, last] }))).toEqual({
      videoPath: '/a/video.mp4',
      imagePath: '/new.png'
    });
  });

  it('без принятого видео берёт результат последнего пакета и скачанное изображение', () => {
    const request = { downloads: ['/r/result.mp4', '/r/sheet.png'] } as unknown as PackageView['request'];
    const view = shotPreview(shot({ packages: [pkg({ request })] }));
    expect(view).toEqual({ videoPath: '/r/result.mp4', imagePath: '/r/sheet.png' });
  });

  it('без материалов возвращает заглушку', () => {
    expect(shotPreview(shot({}))).toEqual({ videoPath: null, imagePath: null });
  });
});
