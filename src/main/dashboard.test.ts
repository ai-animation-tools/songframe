/** Пользовательские подписи читаются из временного проекта без изменения исходных JSON и медиа. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { viewDashboard } from './dashboard';

let project: string;
function write(name: string, value: unknown): void {
  const path = join(project, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}
function registry(stateFrom: string | null = null): object {
  return {
    schema_version: 1,
    fps: 30,
    sequences: [{ id: 'intro', title: 'Вступление' }],
    references: {},
    scenes: [{ id: 'M01', sequence: 'intro', original: '', start_frame: 0, end_frame_exclusive: 30, references: [], state_from: stateFrom, state_changes: {} }]
  };
}
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-dashboard-text-'));
  write('plan/project.json', { schema_version: 1, name: 'Клип' });
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

it('показывает целую причину отсутствующего сценария', () => {
  expect(viewDashboard(project, null)).toEqual({
    shots: [],
    summary: { total: 0, completed: 0, stale: 0, progress: 0, planned: 0, duration: 0, completedSeconds: 0 },
    problems: ['Сначала нужен сценарий. Создайте его на странице «Сценарий».']
  });
});

it.each([
  [0, '?×?, ? FPS, кадров: 0, 0.00 с'],
  [1, '?×?, ? FPS, кадров: 1, 1.00 с'],
  [2, '?×?, ? FPS, кадров: 2, 2.00 с'],
  [5, '?×?, ? FPS, кадров: 5, 5.00 с'],
  [11, '?×?, ? FPS, кадров: 11, 11.00 с'],
  [21, '?×?, ? FPS, кадров: 21, 21.00 с'],
  [-2, '?×?, ? FPS, кадров: -2, -2.00 с'],
  [1.5, '?×?, ? FPS, кадров: 1.5, 1.50 с']
])('показывает числовые метаданные без изменения исходных строк (%s)', (value, expected) => {
  write('plan/scenes.json', registry());
  const path = 'assets/shots/M01/manifest.json';
  write(path, { shot: 'M01', generation: { original_media: { nb_frames: String(value), duration: String(value) } } });
  const before = readFileSync(join(project, path));
  expect(viewDashboard(project, null).shots[0].asset?.originalMedia).toBe(expected);
  expect(readFileSync(join(project, path))).toEqual(before);
});

it('сохраняет заглушки неизвестных метаданных, подпись входа и ещё не начатой работы', () => {
  write('plan/scenes.json', registry());
  expect(viewDashboard(project, null).shots[0].stageLabel).toBe('постановка есть, работа не начата');
  write('assets/shots/M01/frame.png', 'изображение');
  write('assets/shots/M01/manifest.json', { shot: 'M01', generation: { original_media: {}, inputs: [{ path: 'frame.png' }] } });
  const shot = viewDashboard(project, null).shots[0];
  expect(shot.asset?.originalMedia).toBe('?×?, ? FPS, кадров: ?, 0.00 с');
  expect(shot.keyframes).toEqual([{ imagePath: join(project, 'assets/shots/M01/frame.png'), label: 'вход запроса', approved: true }]);
});

it('возвращает настоящую ошибку вычисления состояния в обеих врезках без изменения реестра', () => {
  write('plan/scenes.json', registry('M99'));
  const before = readFileSync(join(project, 'plan/scenes.json'));
  const view = viewDashboard(project, null);
  expect(view.shots[0].before).toBeNull();
  expect(view.shots[0].after).toBeNull();
  expect(view.problems.slice(-2)).toEqual([
    'M01: состояние не вычислено: M99: неизвестный источник state_from.',
    'M01: состояние не вычислено: M99: неизвестный источник state_from.'
  ]);
  expect(readFileSync(join(project, 'plan/scenes.json'))).toEqual(before);
});
