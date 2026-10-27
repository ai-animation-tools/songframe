/** Снимок list может отстать от потока: результат не должен откатываться или дублироваться. */
import { describe, expect, it } from 'vitest';
import type { AgentEvent, AgentJob } from '@shared/agents';
import { applyAgentEvent, mergeAgentJobs } from './agentEvents';

const job: AgentJob = {
  schemaVersion: 1,
  id: 'test',
  sequence: 2,
  project: '/clip',
  provider: 'codex',
  task: 'Предложение',
  permissions: 'read-only',
  inputHashes: { prompt: 'a', context: 'b' },
  status: 'running',
  phase: 'Получение ответа',
  startedAt: '2026-10-25T15:00:00Z',
  finishedAt: null,
  exitCode: null,
  result: 'Начало',
  log: ''
};
const event: AgentEvent = { jobId: job.id, project: job.project, sequence: 3, type: 'text_delta', phase: 'Получение ответа', text: ' продолжение' };

describe('Согласование снимка и событий агента', () => {
  it('не дублирует события, уже вошедшие в снимок, и сохраняет пришедшее после него', () => {
    let jobs = applyAgentEvent([{ ...job, sequence: 3, result: 'Начало продолжение' }], event);
    expect(jobs[0].result).toBe('Начало продолжение');
    jobs = applyAgentEvent(jobs, { ...event, sequence: 4, text: '!' });
    jobs = mergeAgentJobs(jobs, [job]);
    expect(jobs[0]).toMatchObject({ sequence: 4, result: 'Начало продолжение!' });
  });
  it('финальный снимок заменяет черновик, старые события не возвращают выполняющееся состояние', () => {
    const completed = { ...job, sequence: 5, status: 'completed' as const, result: 'Итог' };
    const jobs = applyAgentEvent([job], { ...event, type: 'completed', sequence: 5, job: completed });
    expect(applyAgentEvent(jobs, event)[0]).toEqual(completed);
  });
});
