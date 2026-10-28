/** Готовое предложение остаётся кандидатом; устаревшее предложение нельзя применить. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ProductionProposal } from '@shared/production-workflow';
import { ProductionProposalPreview } from './ProductionProposalPreview';

const proposal: ProductionProposal = {
  id: 'proposal-fixture',
  jobId: 'job-fixture',
  stage: 'prompt',
  status: 'ready',
  stale: false,
  before: 'Старый промпт',
  after: { schemaVersion: 1, stage: 'prompt', prompt: 'Новый промпт' }
};

function render(value: ProductionProposal): string {
  return renderToStaticMarkup(createElement(ProductionProposalPreview, { proposal: value, busy: false, onApply: vi.fn(), onDiscard: vi.fn() }));
}

describe('preview производства', () => {
  it('показывает обе версии и отдельное применение без автоматического принятия', () => {
    const html = render(proposal);
    expect(html).toContain('Старый промпт');
    expect(html).toContain('Новый промпт');
    expect(html).toMatch(/<button(?![^>]* disabled)[^>]*>(?:(?!<\/button>)[\s\S])*Применить предложение<\/button>/);
    expect(html).toContain('не принимает опоры');
  });

  it('блокирует применение устаревшего предложения', () => {
    const html = render({ ...proposal, stale: true });
    expect(html).toMatch(/<button[^>]* disabled[^>]*>(?:(?!<\/button>)[\s\S])*Применить предложение<\/button>/);
    expect(html).toContain('Подготовьте новое предложение');
  });

  it('не даёт применять только завершённый job без проверенного предложения', () => {
    const html = render({ ...proposal, status: 'invalid', after: null });
    expect(html).toMatch(/<button[^>]* disabled[^>]*>(?:(?!<\/button>)[\s\S])*Применить предложение<\/button>/);
  });

  it('показывает описание структурно: опоры с ролями и временем, а не JSON', () => {
    const html = render({
      ...proposal,
      stage: 'description',
      before: '',
      after: {
        schemaVersion: 1,
        stage: 'description',
        description: 'Средний план в салоне джипа.',
        requestSeconds: 4,
        keyframes: [
          { id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Олег за рулём, мотор дрожит.', referencePaths: ['source/heroes/oleg.png'] },
          { id: 'K02', role: 'last', timeSeconds: 4, prompt: 'Стрелки упали, лампы горят.', referencePaths: [] }
        ]
      }
    });
    expect(html).toContain('В пакете ещё нет описания и плана опор');
    expect(html).toContain('Первый кадр');
    expect(html).toContain('Последний кадр');
    expect(html).toContain('4 с от начала плана');
    expect(html).toContain('Референсы: oleg.png');
    expect(html).not.toContain('&quot;requestSeconds&quot;');
    expect(html).toContain('Сейчас в пакете');
    expect(html).toContain('Предложение агента');
  });

  it('показывает черновик запроса подписями входов и параметрами', () => {
    const html = render({
      ...proposal,
      stage: 'request',
      before: JSON.stringify({ stage: 'prompt_review', keyframes: [{}, {}], prompt: { approved: true } }),
      after: {
        schemaVersion: 1,
        stage: 'request',
        request: {
          model: 'kling-video-v3_0',
          command: 'image_to_video',
          parameters: { duration: 5, resolution: '1080p' },
          inputs: [{ flag: 'input', slot: 'image_1', role: 'first', path: 'frames/K01.png' }],
          outputs: 1
        }
      }
    });
    expect(html).toContain('видео по опорным кадрам');
    expect(html).toContain('Первый кадр (Изображение 1): K01.png');
    expect(html).toContain('Опор в пакете: 2; видеопромпт принят');
    expect(html).not.toContain('&quot;model&quot;');
  });
});
