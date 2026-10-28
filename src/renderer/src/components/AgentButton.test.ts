/** Явный значок и настройки по умолчанию не заменяют сохранённый выбор доступных исполнителей. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AiAccess } from '@shared/ai-access';
import { AgentButton } from './AgentButton';
import { AiButton } from './AiButton';
import { AgentJobCard } from './AgentJobCard';
import type { AgentJob } from '@shared/agents';

const context = vi.hoisted(() => ({ agentProvider: null as 'codex' | 'claude' | null, aiAccess: null as AiAccess | null }));
vi.mock('../state', () => ({ useApp: () => context }));
const ready = (): AiAccess => ({
  agent: { provider: 'codex', selected: true, available: true, message: '' },
  image: { provider: 'codex', selected: true, available: true, message: '' },
  video: { provider: 'kling', selected: true, available: true, message: '' }
});
const render = (props: Parameters<typeof AgentButton>[0] = {}): string => renderToStaticMarkup(createElement(AgentButton, props, 'Создать'));
const disabled = (html: string): boolean => /<button[^>]*disabled=""/.test(html);

beforeEach(() => {
  context.agentProvider = 'codex';
  context.aiAccess = ready();
});

describe('Общий запрет AI-действий', () => {
  it('блокирует действие без выбранного глобального агента даже при готовом ответе для Codex', () => {
    context.agentProvider = null;
    expect(disabled(render())).toBe(true);
    expect(render()).toContain('Сначала выберите агента');
  });

  it('не считает provider по умолчанию явным выбором', () => {
    context.aiAccess!.agent.selected = false;
    context.aiAccess!.agent.message = 'Выберите агента в настройках.';
    expect(disabled(render({ provider: 'codex' }))).toBe(true);
  });

  it('блокирует выбранного агента без установленного CLI и объясняет причину', () => {
    context.aiAccess!.agent.available = false;
    context.aiAccess!.agent.message = 'Codex не найден.';
    const html = render();
    expect(disabled(html)).toBe(true);
    expect(html).toContain('Codex не найден.');
    expect(html).toContain('tabindex="0"');
  });

  it('блокирует генерацию до выбора провайдера изображений при доступном текстовом агенте', () => {
    context.aiAccess!.image.selected = false;
    context.aiAccess!.image.message = 'Выберите провайдера изображений.';
    expect(disabled(render({ aiKind: 'image' }))).toBe(true);
    expect(disabled(render())).toBe(false);
    const direct = renderToStaticMarkup(createElement(AiButton, { aiKind: 'image' }, 'Создать в Kling'));
    expect(disabled(direct)).toBe(true);
    expect(direct).toContain('Выберите провайдера изображений.');
  });

  it('разрешает действие только после явного выбора доступного исполнителя', () => {
    expect(disabled(render())).toBe(false);
    expect(disabled(render({ aiKind: 'image', provider: 'codex' }))).toBe(false);
    expect(disabled(render({ aiKind: 'video' }))).toBe(false);
    expect(disabled(render({ disabled: true }))).toBe(true);
  });

  it('явный provider задания не обходит глобальную блокировку и ожидание проверки', () => {
    context.aiAccess = null;
    expect(disabled(render({ provider: 'claude' }))).toBe(true);
    expect(render()).toContain('Проверяем выбор');
    context.agentProvider = null;
    expect(disabled(render({ provider: 'codex' }))).toBe(true);
  });

  it('позволяет проверить явно выбранный профиль формы до сохранения и установки CLI', () => {
    context.agentProvider = null;
    context.aiAccess = null;
    expect(disabled(render({ setup: true, provider: 'codex' }))).toBe(false);
    expect(disabled(render({ setup: true }))).toBe(true);
    expect(disabled(render({ setup: true, provider: 'codex', disabled: true }))).toBe(true);
  });
});

describe('Знак агента на кнопке', () => {
  const icons = (html: string): string[] => [...html.matchAll(/data-agent-icon="([^"]+)"/g)].map((match) => match[1]);

  it('показывает ровно один знак сохранённого агента', () => {
    expect(icons(render())).toEqual(['codex']);
    context.agentProvider = 'claude';
    context.aiAccess!.agent.provider = 'claude';
    expect(icons(render())).toEqual(['claude']);
  });

  it('без выбранного агента показывает нейтральный значок вместо обоих логотипов', () => {
    context.agentProvider = null;
    const html = render();
    expect(icons(html)).toEqual([]);
    expect(html).toContain('data-testid="SmartToyOutlinedIcon"');
    expect(icons(render({ external: true }))).toEqual([]);
  });

  it('действие внешнего агента не требует доступности CLI в приложении', () => {
    context.aiAccess!.agent.available = false;
    expect(disabled(render({ external: true }))).toBe(false);
    expect(icons(render({ external: true }))).toEqual(['codex']);
  });
});

it('сохраняет остановку уже запущенного задания без выбранного агента, но блокирует новый повтор', () => {
  context.agentProvider = null;
  context.aiAccess = null;
  const job = { id: 'job', provider: 'codex', status: 'running', task: 'Подготовить описание', startedAt: '2026-10-27T10:00:00Z' } as AgentJob;
  const running = renderToStaticMarkup(createElement(AgentJobCard, { job, onCancel: vi.fn(), onRetry: vi.fn() }));
  expect(running).toContain('Остановить');
  expect(disabled(running)).toBe(false);
  const failed = renderToStaticMarkup(createElement(AgentJobCard, { job: { ...job, status: 'failed' }, onCancel: vi.fn(), onRetry: vi.fn() }));
  expect(failed).toContain('Повторить');
  expect(disabled(failed)).toBe(true);
});
