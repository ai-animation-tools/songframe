import type { JobInfo } from '@shared/types';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { LinkedText } from '../components/LinkedText';
import { describe, expect, it } from 'vitest';
import { agentFinishedNotice, agentOwnerShowsResult, finishedNotice, newDerivedResult, ownerShowsResult, routeOf } from './backgroundJobs';

describe('общий наблюдатель заданий', () => {
  it('не дублирует итог на странице, которая сообщает сама', () => {
    expect(routeOf('#/project/montage?shots=M01')).toBe('/project/montage');
    expect(ownerShowsResult({ kind: 'submit' }, '/project/production')).toBe(true);
    expect(ownerShowsResult({ kind: 'submit' }, '/project/montage')).toBe(false);
  });
  it('сообщает локальную сборку общим наблюдателем на любой странице, не меняя остальные tool-задания', () => {
    const derived = { kind: 'tool' as const, steps: [{ tool: 'derive_shot' }] as JobInfo['steps'] };
    expect(ownerShowsResult(derived, '/project/production')).toBe(false);
    expect(ownerShowsResult(derived, '/project')).toBe(false);
    expect(ownerShowsResult(derived, '/project/montage')).toBe(false);
    expect(ownerShowsResult({ kind: 'tool' }, '/project/production')).toBe(false);
    expect(ownerShowsResult({ kind: 'tool' }, '/project')).toBe(true);
  });
  it('узнаёт короткое новое задание, пропуская старую завершённую историю и повторный итог', () => {
    const job = {
      status: 'done',
      startedAt: '2026-10-30T10:00:01Z',
      steps: [{ tool: 'derive_shot' }]
    } as JobInfo;
    const started = Date.parse('2026-10-30T10:00:00Z');
    expect(newDerivedResult(job, undefined, started)).toBe(true);
    expect(newDerivedResult(job, 'done', started)).toBe(false);
    expect(newDerivedResult({ ...job, startedAt: '2026-10-29T10:00:00Z' }, undefined, started)).toBe(false);
    expect(newDerivedResult({ ...job, startedAt: '2026-10-29T10:00:00Z' }, 'running', started)).toBe(true);
    expect(newDerivedResult({ ...job, status: 'running' }, undefined, started)).toBe(false);
    expect(newDerivedResult({ ...job, steps: [{ tool: 'check' }] as JobInfo['steps'] }, undefined, started)).toBe(false);
    expect(finishedNotice({ title: 'Приёмка M02', status: 'interrupted', error: 'Сеанс завершён.' })).toEqual({
      message: 'Приёмка M02: не выполнено. Сеанс завершён. Подробности — в журнале заданий.',
      severity: 'error'
    });
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

// Целые сообщения и переходы ожидаются независимо от словарей и таблицы страниц.
describe('сохранение фоновых уведомлений', () => {
  it.each([
    ['completed', 'Агент закончил работу: предложение готово к просмотру.', 'success'],
    ['cancelled', 'Задание агента остановлено.', 'warning'],
    ['failed', 'Задание агента не выполнено. Подробности — в журнале заданий.', 'error']
  ] as const)('сохраняет фразу и ссылку при %s', (status, prefix, severity) => {
    for (const [task, page, route] of [
      ['ai-clip-scenario', 'Сценарий', '/project/scenario'],
      ['ai-clip-scenario:scenes', 'Сценарий', '/project/scenario'],
      ['ai-clip-scene:prepare', 'Производство', '/project/production']
    ]) {
      const notice = agentFinishedNotice({ task, status });
      expect(notice).toEqual({ message: `${prefix} Откройте страницу «${page}».`, severity });
      const html = renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/jobs'] }, createElement(LinkedText, { text: notice.message })));
      expect(html).toContain(`href="${route}"`);
      expect(html).toContain(`«${page}»</a>.`);
    }
  });

  it('сохраняет пробелы вокруг отсутствующей и сложной ошибки', () => {
    expect(finishedNotice({ title: 'Запрос «А»', status: 'failed' })).toEqual({
      message: 'Запрос «А»: не выполнено. Подробности — в журнале заданий.',
      severity: 'error'
    });
    expect(finishedNotice({ title: 'Запрос «А»', status: 'failed', error: 'C:\\Клип & <кадр>\nОшибка' }).message).toBe(
      'Запрос «А»: не выполнено. C:\\Клип & <кадр>\nОшибка Подробности — в журнале заданий.'
    );
  });
});
