import { describe, expect, it } from 'vitest';
import { agentFinishedNotice, agentOwnerShowsResult, finishedNotice, ownerShowsResult, routeOf } from './backgroundJobs';

describe('общий наблюдатель заданий', () => {
  it('не дублирует итог на странице, которая сообщает сама', () => {
    expect(routeOf('#/project/montage?shots=M01')).toBe('/project/montage');
    expect(ownerShowsResult({ kind: 'submit' }, '/project/production')).toBe(true);
    expect(ownerShowsResult({ kind: 'submit' }, '/project/montage')).toBe(false);
  });
  it('называет задание и ведёт в журнал при сбое', () => {
    expect(finishedNotice({ title: 'Отправка M08', status: 'done' })).toEqual({ message: 'Отправка M08: выполнено.', severity: 'success' });
    expect(finishedNotice({ title: 'Отправка M08', status: 'failed', error: 'Нет связи.' }).message).toBe(
      'Отправка M08: не выполнено. Нет связи. Подробности — в журнале заданий.'
    );
  });
  it('сообщает о задании агента вне его страницы', () => {
    expect(agentOwnerShowsResult({ task: 'ai-clip-scenario:scenes' }, '/project/scenario')).toBe(true);
    expect(agentOwnerShowsResult({ task: 'ai-clip-scene:prepare' }, '/jobs')).toBe(false);
    expect(agentOwnerShowsResult({ task: 'Опоры M23: Codex' }, '/project/production')).toBe(true);
    expect(agentFinishedNotice({ task: 'ai-clip-scenario:scenes', status: 'completed' }).message).toContain('«Сценарий»');
    expect(agentFinishedNotice({ task: 'ai-clip-scene:prepare', status: 'failed' }).severity).toBe('error');
  });
});
