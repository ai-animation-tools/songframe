/** Проверки зависимостей сборки на временных файлах: выбранные материалы, история и кеш больших входов. */
import type * as FileSystem from 'node:fs';
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, readSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { setAnimaticStatus, viewAnimatic } from './animatic';
import { cachedFileDigest, type AnimaticManifest } from './animatic-freshness';
import { computeStatus } from './status';

vi.mock('node:fs', async (original) => {
  const fs = await original<typeof FileSystem>();
  return { ...fs, readSync: vi.fn(fs.readSync) };
});

let project: string;
let manifest: AnimaticManifest;
const snapshot = 'plan/animatic/latest/manifest.json';
const packageDir = 'plan/batches/M03-attempt-01';
const hash = (value: string): string => createHash('sha256').update(value).digest('hex');
function write(name: string, value: string | object): void {
  const path = join(project, name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}
function json<T>(name: string): T {
  return JSON.parse(readFileSync(join(project, name), 'utf8')) as T;
}
function accepted(id: string, path: string, content: string, frames = 30): void {
  write(`assets/shots/${id}/${path}`, content);
  write(`assets/shots/${id}/manifest.json`, { shot: id, accepted_edit: { fps: 30, frames, video: { path, sha256: hash(content) } } });
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-freshness-'));
  write('plan/project.json', { schema_version: 1, name: 'Проба', animatic_video: 'clip.mp4' });
  write('plan/scenes.json', { scenes: ['M01', 'M02', 'M03'].map((id) => ({ id })), references: { hero: { path: 'source/hero.png' } } });
  write('source/track.mp3', 'track');
  write('source/hero.png', 'hero');
  accepted('M01', 'edit.mp4', 'video');
  write('plan/animatic/cards/M02.png', 'card');
  write('plan/animatic/cards/M03.png', 'first-card');
  write('plan/animatic/cards/M03.last.png', 'last-card');
  write(`${packageDir}/frames/K01.png`, 'first-source');
  write(`${packageDir}/frames/K02.png`, 'last-source');
  write('plan/animatic/latest/clip.mp4', 'animatic');
  const frames = [
    { id: 'K01', role: 'first', time_seconds: 0, path: `${packageDir}/frames/K01.png`, sha256: hash('first-source') },
    { id: 'K02', role: 'last', time_seconds: 2, path: `${packageDir}/frames/K02.png`, sha256: hash('last-source') }
  ];
  write(`${packageDir}/workflow.json`, {
    shot: 'M03',
    stage: 'prompt_review',
    keyframes: frames.map((frame) => ({ ...frame, path: `frames/${frame.id}.png`, approved: true }))
  });
  manifest = {
    scene_registry_sha256: hash(readFileSync(join(project, 'plan/scenes.json'), 'utf8')),
    video_file: 'clip.mp4',
    video_sha256: hash('animatic'),
    source_hashes: Object.fromEntries(
      [
        'plan/project.json',
        'source/track.mp3',
        'source/hero.png',
        'assets/shots/M01/edit.mp4',
        'plan/animatic/cards/M02.png',
        'plan/animatic/cards/M03.png',
        'plan/animatic/cards/M03.last.png',
        ...frames.map((frame) => frame.path)
      ].map((name) => [name, hash(readFileSync(join(project, name), 'utf8'))])
    ),
    shots: [
      { id: 'M01', media: 'video', frames: 30, path: 'assets/shots/M01/edit.mp4', sha256: hash('video') },
      { id: 'M02', media: 'card', path: 'plan/animatic/cards/M02.png', references: ['hero'] },
      { id: 'M03', media: 'keyframes', path: 'plan/animatic/cards/M03.png', path_last: 'plan/animatic/cards/M03.last.png', keyframes: frames }
    ]
  };
  write(snapshot, manifest);
  write('plan/production-status.json', { current_animatic_status: 'approved', approved_animatic: { video_sha256: hash('animatic') } });
  vi.mocked(readSync).mockClear();
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

it('одинаково определяет свежесть в плеере и статусе проекта, сохраняя принятие', () => {
  const view = viewAnimatic(project);
  expect(view.built?.fresh).toBe(true);
  expect(view.approval.current).toBe(true);
  expect(view.problems).toEqual([]);
  expect(computeStatus(project).checks).toMatchObject({ animaticFresh: true, animaticApproved: true });
});

it.each([
  'assets/shots/M01/edit.mp4',
  'plan/animatic/cards/M02.png',
  'plan/animatic/cards/M03.last.png',
  `${packageDir}/frames/K01.png`,
  `${packageDir}/frames/K02.png`,
  'source/hero.png',
  'source/track.mp3',
  'plan/project.json',
  'plan/animatic/latest/clip.mp4'
])('изменение фактически использованного входа %s снимает актуальное принятие, сохраняя историю', (name) => {
  expect(viewAnimatic(project).built?.fresh).toBe(true);
  const history = readFileSync(join(project, 'plan/production-status.json'), 'utf8');
  write(name, 'changed');
  const view = viewAnimatic(project);
  expect(view.built?.fresh).toBe(false);
  expect(view.approval).toMatchObject({ status: 'approved', current: false, approvedSha256: hash('animatic') });
  expect(view.problems.join(' ')).toContain(name);
  expect(readFileSync(join(project, 'plan/production-status.json'), 'utf8')).toBe(history);
  expect(() => setAnimaticStatus(project, 'approved')).toThrow(/устаревшему/);
});

it('переключение принятого монтажа и появление видео вместо карточки требуют пересборки', () => {
  accepted('M01', 'replacement.mp4', 'video');
  expect(viewAnimatic(project).problems.join(' ')).toContain('выбранный принятый монтаж изменился');
  accepted('M01', 'edit.mp4', 'video');
  accepted('M02', 'edit.mp4', 'new-video');
  expect(viewAnimatic(project).problems.join(' ')).toContain('вместо карточки появился принятый монтаж');
});

it('непринятые кандидаты и даже принятые альтернативные опоры готового видео не меняют сборку', () => {
  for (const id of ['M01', 'M02', 'M03']) {
    const directory = `plan/batches/${id}-new`;
    write(`${directory}/K01.png`, 'candidate');
    write(`${directory}/workflow.json`, { shot: id, stage: 'keyframes_review', keyframes: [{ id: 'K01', approved: id === 'M01', path: 'K01.png' }] });
  }
  expect(viewAnimatic(project).built?.fresh).toBe(true);
  expect(viewAnimatic(project).problems).toEqual([]);
});

it('снятое принятие или изменение времени выбранной опоры обнаруживается без перерисовки карточки', () => {
  const name = `${packageDir}/workflow.json`;
  const workflow = json<{ keyframes: { approved: boolean; time_seconds: number }[] }>(name);
  workflow.keyframes[0].approved = false;
  write(name, workflow);
  expect(viewAnimatic(project).built?.fresh).toBe(false);
  workflow.keyframes[0].approved = true;
  workflow.keyframes[0].time_seconds = 0.1;
  write(name, workflow);
  expect(viewAnimatic(project).problems.join(' ')).toContain('выбор принятых опор изменился');
});

it('legacy manifest проверяется по имеющимся хешам, при их отсутствии сообщает о пересборке', () => {
  delete manifest.source_hashes;
  write(snapshot, manifest);
  const view = viewAnimatic(project);
  expect(view.built?.fresh).toBe(false);
  expect(view.problems.join(' ')).toContain('Нет сохранённого хеша входа plan/project.json');
});

it('кеш не перечитывает MP4 на повторных опросах и замечает замену байтов при прежних size/mtime', () => {
  const name = join(project, 'assets/shots/M01/edit.mp4');
  const before = statSync(name);
  expect(cachedFileDigest(name)).toBe(hash('video'));
  const calls = vi.mocked(readSync).mock.calls.length;
  expect(cachedFileDigest(name)).toBe(hash('video'));
  expect(vi.mocked(readSync).mock.calls.length).toBe(calls);
  writeFileSync(name, 'other');
  utimesSync(name, before.atime, before.mtime);
  expect(cachedFileDigest(name)).toBe(hash('other'));
  expect(vi.mocked(readSync).mock.calls.length).toBeGreaterThan(calls);
  viewAnimatic(project);
  const afterFirstPoll = vi.mocked(readSync).mock.calls.length;
  viewAnimatic(project);
  expect(vi.mocked(readSync).mock.calls.length).toBe(afterFirstPoll);
});
