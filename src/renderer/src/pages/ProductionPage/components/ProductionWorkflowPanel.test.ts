/** Сохранённый возврат подставляется в явную доработку, не запуская агента при показе панели. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProductionWorkflowView } from '@shared/production-workflow';
import { agentTitle } from '@shared/agent-providers';
import { ProductionWorkflowPanel } from './ProductionWorkflowPanel';

const workflow = vi.hoisted(() => ({
  view: null as ProductionWorkflowView | null,
  busy: false,
  error: null,
  start: vi.fn(),
  cancel: vi.fn(),
  generateFrames: vi.fn(),
  importFrames: vi.fn(),
  apply: vi.fn(),
  discard: vi.fn()
}));
vi.mock('../useProductionWorkflow', () => ({ useProductionWorkflow: () => workflow }));
// Повтор проверяется по кнопке задания; содержимое предложения к нему не относится.
vi.mock('./ProductionProposalDialog', () => ({ ProductionProposalDialog: () => null }));
const app = vi.hoisted(() => ({ agentProvider: 'codex' as 'codex' | 'claude' | null }));
vi.mock('../../../state', () => ({
  useApp: () => ({
    agentProvider: app.agentProvider,
    aiAccess: {
      agent: { selected: true, available: true, provider: 'codex', message: '' },
      image: { selected: true, available: true, provider: 'kling', message: '' },
      video: { selected: true, available: true, provider: 'kling', message: '' }
    }
  })
}));

const savedNote = 'Уточнить движение героя.\nСохранить одежду и положение камеры.';
const render = (overrides: Partial<Parameters<typeof ProductionWorkflowPanel>[0]> = {}): string =>
  renderToStaticMarkup(
    createElement(ProductionWorkflowPanel, {
      project: '/fixture',
      shot: 'M44',
      packageDir: '/fixture/package',
      decisionToken: 'returned-note-2',
      decision: { stage: 'prompt_review', verdict: 'revise', note: savedNote },
      packageBusy: false,
      onBusyChange: vi.fn(),
      onApplied: vi.fn(),
      ...overrides
    })
  );
const action = (html: string): string => {
  const button = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find((match) => match[0].includes('Запустить доработку с агентом'));
  expect(button).toBeDefined();
  return button![0];
};

beforeEach(() => {
  vi.clearAllMocks();
  app.agentProvider = 'codex';
  workflow.busy = false;
  workflow.view = {
    project: '/fixture',
    shot: 'M44',
    packageDir: '/fixture/package',
    managed: true,
    busy: false,
    stage: 'prompt_review',
    canPrepare: false,
    canContinue: false,
    canRevise: true,
    canGenerateFrames: false,
    paid: false,
    reasons: { prepare: 'сценарий не утверждён', continue: null, frames: 'опоры уже приняты' },
    imageProvider: 'kling',
    framePrompts: [],
    problems: [],
    proposal: null,
    job: null
  };
});

describe('Явный запуск доработки плана', () => {
  it('подставляет сохранённый многострочный текст и называет отдельное действие запуска', () => {
    const html = render();
    expect(html).toContain('Сохранённое замечание для доработки');
    expect(html).toContain(savedNote);
    expect(html).toContain('Замечание из возврата подставлено ниже.');
    expect(html).toContain('Агент автоматически не запускается.');
    expect(html).toContain('Можно уточнить текст перед запуском.');
    expect(action(html)).not.toContain('disabled=""');
    expect(action(html)).toContain('Codex');
    expect(workflow.start).not.toHaveBeenCalled();
    expect(workflow.generateFrames).not.toHaveBeenCalled();
  });

  it.each([{ packageBusy: true }, { workflowBusy: true }])('сохраняет замечание и блокирует запуск при занятости: %j', (busy) => {
    workflow.busy = !!busy.workflowBusy;
    const html = render({ packageBusy: !!busy.packageBusy });
    expect(html).toContain(savedNote);
    expect(action(html)).toContain('disabled=""');
    expect(workflow.start).not.toHaveBeenCalled();
  });

  it.each(['', ' \n\t '])('не разрешает запуск с пустым замечанием %j', (note) => {
    const html = render({ decision: { stage: 'prompt_review', verdict: 'revise', note } });
    expect(action(html)).toContain('disabled=""');
    expect(workflow.start).not.toHaveBeenCalled();
  });

  it('не подставляет замечание другого ответа и оставляет пустой ввод доработки', () => {
    const html = render({ decision: { stage: 'prompt_review', verdict: 'approve', note: savedNote } });
    expect(html).not.toContain(savedNote);
    expect(html).toContain('Что исправить в текущем этапе');
    expect(action(html)).toContain('disabled=""');
  });

  it('не показывает локальную доработку, когда она недоступна выбранному пакету', () => {
    workflow.view!.canRevise = false;
    const html = render();
    expect(html).not.toContain('Запустить доработку с агентом');
    expect(html).not.toContain('<textarea');
    expect(workflow.start).not.toHaveBeenCalled();
  });

  it('показывает на повторе опор знак исполнителя провайдера изображений, а не выбранного агента', () => {
    app.agentProvider = 'claude';
    const view = workflow.view!;
    view.canRevise = false;
    view.imageProvider = 'codex';
    view.proposal = { id: 'frames-1', stage: 'frames' } as NonNullable<ProductionWorkflowView['proposal']>;
    view.job = {
      schemaVersion: 1,
      id: 'job-1',
      sequence: 1,
      project: '/fixture',
      // Источник знака — реестр провайдера изображений, даже если журнал задания хранит другого агента.
      provider: 'claude',
      task: 'Опоры M44',
      permissions: 'workspace-write',
      inputHashes: { prompt: 'p', context: 'c' },
      status: 'failed',
      phase: 'done',
      startedAt: '2026-10-28T10:00:00.000Z',
      finishedAt: '2026-10-28T10:01:00.000Z',
      exitCode: 1,
      result: '',
      log: ''
    };
    const html = render();
    const retry = [...html.matchAll(/<button\b[^>]*>[\s\S]*?<\/button>/g)].find((match) => match[0].includes('Повторить'));
    expect(retry?.[0]).toContain(`title="${agentTitle('codex')}"`);
  });
});
