import { describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentJob } from '@shared/agents';
import type { JobInfo } from '@shared/types';
import { TaskNotifications } from './task-notifications';

const project = '/test/clip';

function job(overrides: Partial<JobInfo> = {}): JobInfo {
  return {
    id: 'job-1',
    kind: 'review',
    title: 'Проба M01 M02',
    status: 'done',
    startedAt: '2026-10-26T10:00:00Z',
    finishedAt: '2026-10-26T10:01:00Z',
    log: '',
    code: 0,
    steps: [],
    ...overrides
  };
}

function agentEvent(overrides: Partial<AgentJob> = {}, type: AgentEvent['type'] = 'completed'): AgentEvent {
  const agentJob: AgentJob = {
    schemaVersion: 1,
    id: 'agent-1',
    sequence: 1,
    project,
    provider: 'codex',
    task: 'Опоры M01',
    permissions: 'read-only',
    inputHashes: { prompt: '', context: '' },
    status: 'completed',
    phase: 'completed',
    startedAt: '2026-10-26T10:00:00Z',
    finishedAt: '2026-10-26T10:01:00Z',
    exitCode: 0,
    result: '',
    log: '',
    ...overrides
  };
  return { jobId: agentJob.id, project, sequence: 1, phase: agentJob.phase, type, job: agentJob };
}

describe('TaskNotifications', () => {
  it.each([
    ['review', 'Проба M01 M02', 'Проба готова', '/project/checks'],
    ['review', 'Проба M01 (проверка без видео)', 'Проба проверена', '/project/checks'],
    ['animatic', 'Сборка аниматика', 'Аниматик готов', '/project/animatic'],
    ['animatic', 'Проверка входов аниматика', 'Входы аниматика проверены', '/project/animatic']
  ] as const)('сохраняет смысл завершения %s: %s', (kind, title, expectedTitle, route) => {
    const deliver = vi.fn();
    new TaskNotifications(deliver).jobFinished(job({ kind, title }), project);
    expect(deliver).toHaveBeenCalledExactlyOnceWith({ title: expectedTitle, body: title, target: { project, route } });
  });

  it.each([
    ['review', 'Проба M01 M02', 'Ошибка: Проба M01 M02', '/project/checks'],
    ['review', 'Проба M01 (проверка без видео)', 'Ошибка: Проба M01 (проверка без видео)', '/project/checks'],
    ['animatic', 'Сборка аниматика', 'Ошибка: Сборка аниматика', '/project/animatic'],
    ['animatic', 'Проверка входов аниматика', 'Ошибка: Проверка входов аниматика', '/project/animatic']
  ] as const)('сообщает об ошибке целого задания %s: %s один раз', (kind, title, expectedTitle, route) => {
    const deliver = vi.fn();
    const notifications = new TaskNotifications(deliver);
    const failed = job({ kind, title, status: 'failed', code: 1, steps: [{ tool: 'build', label: 'Шаг', status: 'failed', code: 1 }] });
    notifications.jobFinished(failed, project);
    notifications.jobFinished(failed, project);
    expect(deliver).toHaveBeenCalledExactlyOnceWith({
      title: expectedTitle,
      body: title,
      target: { project, route }
    });
  });

  it('пропускает обычные инструменты, проверки, отсутствие проекта и незавершённые задания', () => {
    const deliver = vi.fn();
    const notifications = new TaskNotifications(deliver);
    for (const kind of ['check', 'tool', 'submit', 'regenerate', 'accept', 'contact_sheet', 'model_download'] as const)
      notifications.jobFinished(job({ kind }), project);
    notifications.jobFinished(job(), null);
    notifications.jobFinished(job({ status: 'running' }), project);
    expect(deliver).not.toHaveBeenCalled();
    notifications.jobFinished(job(), project);
    notifications.jobFinished(job(), project);
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it.each(['claude', 'codex'] as const)('сообщает о готовом ответе %s и направляет к сценарию', (provider) => {
    const deliver = vi.fn();
    new TaskNotifications(deliver).agentEvent(agentEvent({ provider, task: 'ai-clip-scenario: черновик', result: 'невалидное предложение' }));
    expect(deliver).toHaveBeenCalledExactlyOnceWith({
      title: `Ответ ${provider === 'claude' ? 'Claude Code' : 'Codex'} готов`,
      body: 'ai-clip-scenario: черновик',
      target: { project, route: '/project/scenario' }
    });
  });

  it('сообщает об ошибке агента и направляет к производству', () => {
    const deliver = vi.fn();
    new TaskNotifications(deliver).agentEvent(agentEvent({ status: 'failed', provider: 'claude' }, 'failed'));
    expect(deliver).toHaveBeenCalledExactlyOnceWith({ title: 'Ошибка Claude Code', body: 'Опоры M01', target: { project, route: '/project/production' } });
  });

  it('не уведомляет о промежуточном ответе, отмене и прерывании', () => {
    const deliver = vi.fn();
    const notifications = new TaskNotifications(deliver);
    for (const type of ['started', 'text_delta', 'tool_started', 'tool_finished'] as const) notifications.agentEvent(agentEvent({}, type));
    for (const status of ['running', 'cancelled', 'interrupted'] as const)
      for (const type of ['completed', 'failed'] as const) notifications.agentEvent(agentEvent({ status }, type));
    notifications.agentEvent({ ...agentEvent(), job: undefined });
    expect(deliver).not.toHaveBeenCalled();
    notifications.agentEvent(agentEvent());
    expect(deliver).toHaveBeenCalledTimes(1);
  });

  it('не повторяет событие агента и различает одинаковые ID агента и инструмента', () => {
    const deliver = vi.fn();
    const notifications = new TaskNotifications(deliver);
    notifications.jobFinished(job({ id: 'same' }), project);
    notifications.agentEvent(agentEvent({ id: 'same' }));
    notifications.agentEvent(agentEvent({ id: 'same' }));
    expect(deliver).toHaveBeenCalledTimes(2);
  });

  it.each([
    [true, 'Черновик разметки готов', 'Откройте разметку для проверки черновика.'],
    [false, 'Ошибка разметки', 'Не удалось подготовить черновик разметки. Вернитесь на страницу «Тайминги».']
  ] as const)('открывает разметку после завершения авторазметки: %s', (success, title, body) => {
    const deliver = vi.fn();
    new TaskNotifications(deliver).timingFinished(project, success);
    expect(deliver).toHaveBeenCalledExactlyOnceWith({
      title,
      body,
      target: { project, route: '/project/timing' }
    });
  });

  it('сохраняет кавычки, пути и специальные символы параметров уведомления об ошибке', () => {
    const deliver = vi.fn();
    new TaskNotifications(deliver).jobFinished(job({ title: 'Проба «M01» /tmp/клип & <draft> "версия"\n2', status: 'failed' }), project);
    expect(deliver).toHaveBeenCalledExactlyOnceWith({
      title: 'Ошибка: Проба «M01» /tmp/клип & <draft> "версия"\n2',
      body: 'Проба «M01» /tmp/клип & <draft> "версия"\n2',
      target: { project, route: '/project/checks' }
    });
  });

  it('не пробрасывает сбои доставки и не пытается повторно показать одно событие', () => {
    const error = new Error('Системные уведомления недоступны');
    const deliver = vi.fn(() => {
      throw error;
    });
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const notifications = new TaskNotifications(deliver);
      expect(() => {
        notifications.jobFinished(job(), project);
        notifications.jobFinished(job(), project);
        notifications.agentEvent(agentEvent());
        notifications.agentEvent(agentEvent());
        notifications.timingFinished(project, true);
      }).not.toThrow();
      expect(deliver).toHaveBeenCalledTimes(3);
      expect(warning).toHaveBeenCalledTimes(3);
      expect(warning).toHaveBeenCalledWith('Не удалось показать системное уведомление:', error);
    } finally {
      warning.mockRestore();
    }
  });
});
