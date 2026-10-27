/** Отсутствующий сценарий не создаёт производственное задание; готовый вход сохраняет цепочку инструментов. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Jobs } from './jobs';
import { Animatic } from './animatic';

let project: string;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-animatic-'));
  mkdirSync(join(project, 'plan'));
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

it.each([true, false])('без сценария отклоняет запуск до Jobs и Python (проверка: %s)', (planOnly) => {
  const start = vi.fn<Jobs['start']>();
  const animatic = new Animatic({ start } as unknown as Jobs);

  expect(() => animatic.build(project, planOnly)).toThrow('Сначала нужен сценарий. Создайте его на странице «Сценарий».');
  expect(start).not.toHaveBeenCalled();
});

it.each([true, false])('со сценарием сохраняет обновление карточек и запуск сборщика (проверка: %s)', (planOnly) => {
  // Содержание реестра проверяют сами инструменты; preflight проверяет только наличие входа.
  writeFileSync(join(project, 'plan', 'scenes.json'), '{}');
  const start = vi.fn<Jobs['start']>();
  const animatic = new Animatic({ start } as unknown as Jobs);

  animatic.build(project, planOnly);

  expect(start).toHaveBeenCalledExactlyOnceWith('animatic', planOnly ? 'Проверка входов аниматика' : 'Сборка аниматика', project, [
    { tool: 'update_scene_views', args: [], label: 'карточки и представления' },
    { tool: 'build_animatic', args: planOnly ? ['--plan-only'] : [], label: planOnly ? 'проверка входов' : 'сборка аниматика' }
  ]);
});
