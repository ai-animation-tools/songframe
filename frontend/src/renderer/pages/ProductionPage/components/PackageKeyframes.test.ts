/** Опоры согласуются по одной: у каждой видно состояние, утверждённую можно вернуть, пока промпт не утверждён. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { PackageView } from '@shared/types';
import { PackageKeyframes } from './PackageKeyframes';

beforeAll(() => {
  vi.stubGlobal('window', { api: { shell: { fileUrl: (path: string) => `songframe-file://${path}` } } });
});

const fixture = (overrides: Partial<PackageView> = {}): PackageView => ({
  dir: '/fixture/package',
  relative: 'package',
  shot: 'M44',
  stage: 'keyframes_review',
  stageLabel: 'опоры на согласовании',
  waitReason: null,
  mode: null,
  retryOf: null,
  batch: null,
  timing: null,
  keyframes: [
    { id: 'K01', role: 'first', time_seconds: 0, imagePath: '/home/user/.config/songframe/image-jobs/1/K01.png', approved: true },
    { id: 'K02', role: 'middle', time_seconds: 2, imagePath: '/home/user/.config/songframe/image-jobs/1/K02.png', approved: false },
    { id: 'K03', role: 'last', time_seconds: 4, imagePath: null, approved: false }
  ],
  sceneChanged: false,
  keyframeNotes: [
    { id: 1, frame: 'K02', note: 'Куртка как на K01.', scope: 'following', active: true },
    { id: 2, frame: 'K01', note: 'Снятое замечание.', scope: 'frame', active: false }
  ],
  description: null,
  prompt: null,
  request: null,
  pendingDecision: { stage: 'keyframes_review', question: 'Утвердить опору K02?', options: ['approve', 'revise'], frame: 'K02' },
  decision: null,
  preview: [],
  problems: [],
  ...overrides
});

const render = (pkg: PackageView): string => renderToStaticMarkup(createElement(PackageKeyframes, { pkg, busy: false, onReopen: vi.fn(), onSetNote: vi.fn() }));

describe('Опоры пакета', () => {
  it('показывает состояние каждой опоры и выделяет опору с вопросом', () => {
    const html = render(fixture());
    expect(html).toContain('утверждено 1 из 3');
    expect(html).toContain('утверждена');
    expect(html).toContain('вопрос ниже: утвердить?');
    expect(html).toContain('не создана');
    expect(html).toContain('Открыть крупно: K01');
  });

  it('не выводит абсолютный путь в подписи и перечисляет только действующие замечания', () => {
    const html = render(fixture());
    expect(html).not.toMatch(/>[^<]*image-jobs[^<]*</);
    expect(html).toContain('Куртка как на K01.');
    expect(html).toContain('K02 и следующие опоры');
    expect(html).not.toContain('Снятое замечание.');
    expect(html).toContain('Снять замечание к K02');
  });

  it('разрешает вернуть утверждённую опору, пока видеопромпт не утверждён', () => {
    const open = render(fixture());
    expect(open).toMatch(/<button[^>]*>(?:(?!<\/button>)[\s\S])*Вернуть на доработку<\/button>/);
    expect(open).not.toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Вернуть на доработку<\/button>/);
    const locked = render(fixture({ prompt: { path: 'video-prompt.txt', approved: true, text: 'Промпт' } }));
    expect(locked).toMatch(/<button[^>]*disabled=""[^>]*>(?:(?!<\/button>)[\s\S])*Вернуть на доработку<\/button>/);
  });
});
