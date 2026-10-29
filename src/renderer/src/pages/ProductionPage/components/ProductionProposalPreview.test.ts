/** Готовое предложение остаётся кандидатом; устаревшее предложение нельзя применить. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { registerMediaProviderForTests } from '@shared/media-providers';
import type { ProductionProposal } from '@shared/production-workflow';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { ProductionProposalPreview } from './ProductionProposalPreview';

let restoreProvider: () => void;
beforeAll(() => {
  restoreProvider = registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo);
});
afterAll(() => restoreProvider());

const proposal: ProductionProposal = {
  id: 'proposal-fixture',
  jobId: 'job-fixture',
  stage: 'prompt',
  status: 'ready',
  stale: false,
  before: 'Старый промпт',
  after: { schemaVersion: 1, stage: 'prompt', prompt: 'Новый промпт' }
};

function render(value: ProductionProposal, videoProvider: string | null = null): string {
  return renderToStaticMarkup(createElement(ProductionProposalPreview, { proposal: value, videoProvider, busy: false, onApply: vi.fn(), onDiscard: vi.fn() }));
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
    const request = (command: string): ProductionProposal => ({
      ...proposal,
      stage: 'request',
      before: JSON.stringify({ stage: 'prompt_review', keyframes: [{}, {}], prompt: { approved: true } }),
      after: {
        schemaVersion: 1,
        stage: 'request',
        request: {
          model: 'test-video-v3_0',
          command,
          parameters: { duration: 5, resolution: '1080p' },
          inputs: [{ flag: 'input', slot: 'image_1', role: 'first', path: 'frames/K01.png' }],
          outputs: 1
        }
      }
    });
    const html = render(request('image_to_video'), TEST_PROVIDER);
    // Подпись команды даёт реестр провайдера видео; неизвестная команда показывается своим именем.
    expect(html).toContain(testProviderInfo.commandLabels.image_to_video);
    expect(render(request('unknown_command'), TEST_PROVIDER)).toContain('unknown_command');
    expect(render(request('image_to_video'))).toContain('image_to_video');
    expect(html).toContain('Первый кадр (Изображение 1): K01.png');
    expect(html).toContain('Опор в пакете: 2; видеопромпт принят');
    expect(html).not.toContain('&quot;model&quot;');
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
    expect(html).toMatch(/<button[^>]* disabled[^>]*>(?:(?!<\/button>)[\s\S])*Применить предложение<\/button>/);
  });
});
