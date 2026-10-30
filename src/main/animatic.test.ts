/** Отсутствующий сценарий не создаёт производственное задание; готовый вход сохраняет цепочку инструментов. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Jobs } from './jobs';
import { Animatic, setAnimaticStatus, viewAnimatic } from './animatic';

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

// Пустое имя отличается от отсутствующего: nullish-подстановка не должна менять эту ветку.
it.each([
  [undefined, 'MP4 сборки не найден: имя не записано. Соберите аниматик заново.'],
  [null, 'MP4 сборки не найден: имя не записано. Соберите аниматик заново.'],
  ['', 'MP4 сборки не найден: . Соберите аниматик заново.'],
  ['«Проба» & <1>.mp4', 'MP4 сборки не найден: «Проба» & <1>.mp4. Соберите аниматик заново.']
])('сохраняет полную ошибку отсутствующего MP4 (%s) при чтении', (filename, expected) => {
  const directory = join(project, 'plan/animatic/latest');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'manifest.json');
  writeFileSync(path, JSON.stringify({ video_file: filename, shots: [] }));
  const before = readFileSync(path);
  const view = viewAnimatic(project);
  expect(view.built?.videoPath).toBeNull();
  expect(view.problems).toContain(expected);
  expect(view.approval.current).toBe(false);
  expect(readFileSync(path)).toEqual(before);
});

it('объясняет повреждённый манифест и отклоняет принятие до создания production-status', () => {
  const directory = join(project, 'plan/animatic/latest');
  mkdirSync(directory, { recursive: true });
  const path = join(directory, 'manifest.json');
  writeFileSync(path, '{ «повреждён»');
  expect(viewAnimatic(project).problems).toEqual([
    'Сначала нужен сценарий. Создайте его на странице «Сценарий».',
    'plan/animatic/latest/manifest.json повреждён.'
  ]);
  expect(() => setAnimaticStatus(project, 'approved')).toThrow(new Error('Нет собранного аниматика: сначала соберите его.'));
  expect(readFileSync(path, 'utf8')).toBe('{ «повреждён»');
});
