import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ShotProduction } from '@shared/types';
import { ProductionShotCard } from './ProductionShotCard';

const shot: ShotProduction = {
  id: 'M02',
  title: 'Производный',
  original: 'Постановка',
  start: 3,
  end: 6,
  lipsync: false,
  state: 'completed',
  stageLabel: '',
  regenerateProblem: null,
  derivedFrom: 'M01',
  attention: null,
  asset: { dir: '/M02', video: '/M02/clip.mp4', original: '/M02/original.mp4' },
  packages: []
};
function render(current = shot) {
  return renderToStaticMarkup(
    createElement(
      MemoryRouter,
      null,
      createElement(ProductionShotCard, {
        shot: current,
        busy: false,
        pythonAvailable: true,
        onRegenerate: vi.fn()
      })
    )
  );
}
beforeEach(() => vi.stubGlobal('window', { api: { shell: { fileUrl: (path: string) => `songframe-file://${path}` } } }));
afterEach(() => vi.unstubAllGlobals());

describe('принятый комплект производного плана', () => {
  it('оставляет просмотр принятого результата и переход к постановке, убирая повтор генерации', () => {
    const html = render();
    expect(html).toContain('src="songframe-file:///M02/clip.mp4"');
    expect(html).toContain('src="songframe-file:///M02/original.mp4"');
    expect(html).toContain('В сценарии');
    expect(html).not.toContain('Подготовить повтор');
    expect(html).toContain('href="/project/production?shot=M01"');
    expect(html).not.toContain('пока не поддерживается');
  });

  it('для устаревшего источника показывает конкретную причину вместо сообщения о правке постановки', () => {
    const html = render({ ...shot, state: 'stale', staleReason: 'Принятый клип источника M01 заменён.' });
    expect(html).toContain('Принятый клип источника M01 заменён.');
    expect(html).not.toContain('Постановка или унаследованное');
  });
});
