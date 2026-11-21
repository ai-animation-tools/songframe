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
    expect(html).toMatch(/<button(?![^>]* disabled)[^>]*>(?:(?!<\/button>)[\s\S])*Принять<\/button>/);
    expect(html).toContain('не принимает опоры');
  });

  it('блокирует применение устаревшего предложения', () => {
    const html = render({ ...proposal, stale: true });
    expect(html).toMatch(/<button[^>]* disabled[^>]*>(?:(?!<\/button>)[\s\S])*Принять<\/button>/);
    expect(html).toContain('Подготовьте новое предложение');
  });

  it('не даёт применять только завершённый job без проверенного предложения', () => {
    const html = render({ ...proposal, status: 'invalid', after: null });
    expect(html).toMatch(/<button[^>]* disabled[^>]*>(?:(?!<\/button>)[\s\S])*Принять<\/button>/);
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
    expect(html).toContain('В попытке ещё нет описания и плана опор');
    expect(html).toContain('Первый кадр');
    expect(html).toContain('Последний кадр');
    expect(html).toContain('4 с от начала плана');
    expect(html).toContain('Референсы: oleg.png');
    expect(html).not.toContain('&quot;requestSeconds&quot;');
    expect(html).toContain('Сейчас в попытке');
    expect(html).toContain('Предложение агента');
  });

  it('показывает отказ агента его причиной, без ошибки разбора JSON', () => {
    const html = render({
      ...proposal,
      stage: 'description',
      status: 'invalid',
      before: '',
      after: null,
      refused: true,
      message: 'Агент отказался подготовить предложение. Возможно, в сценарии есть противоречия.',
      agentText: 'Не могу подготовить согласованное предложение M59: нужно уточнить конечную эмоцию в сценарии.'
    });
    expect(html).toContain('Агент отказался подготовить предложение. Возможно, в сценарии есть противоречия.');
    expect(html).toContain('Причина отказа');
    expect(html).toContain('нужно уточнить конечную эмоцию');
    expect(html).toContain('отклоните предложение: сохранённое замечание откроется на шаге');
    expect(html).not.toContain('Причина проверки');
    expect(html).not.toContain('Ответ агента');
  });

  it('показывает ответ агента и причину, когда предложение не прошло проверку', () => {
    const html = render({
      ...proposal,
      stage: 'description',
      status: 'invalid',
      before: '',
      after: null,
      message: 'Описание требует текст, длительность и минимум две опоры.',
      agentText: 'Для M01 задано точное повторное использование кадра M13; генерация не обеспечит повторение.'
    });
    expect(html).toContain('Агент не подготовил предложение');
    expect(html).toContain('точное повторное использование кадра M13');
    expect(html).toContain('Причина проверки');
    expect(html).toContain('минимум две опоры');
    expect(html).not.toContain('Предложение ещё не получено');
    expect(html).toMatch(/<button[^>]* disabled[^>]*>(?:(?!<\/button>)[\s\S])*Принять<\/button>/);
  });
});
