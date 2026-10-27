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
});
