/** Применение проверяется на временных проектах: ошибки CLI, устаревание и восстановление всего набора. */
import { createHash } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ScenarioPublication } from '@shared/scenario-workflow';
import type { CastFile, ScenesFile, TreatmentFile, ToolResult } from '@shared/types';
import * as localFiles from './local-files';
import type { PythonLauncher } from './python-launcher';
import { publishScenario, recoverScenarioApplications, scenarioOutputPaths } from './scenario-apply';
import { sourceInputDigest } from './source-input-hash';

let work: string;
let project: string;
let localDir: string;
let cast: CastFile;
let treatment: TreatmentFile;
let scenes: ScenesFile;
const hash = (value: Uint8Array | string): string => createHash('sha256').update(value).digest('hex');
const json = (value: unknown): string => JSON.stringify(value, null, 2) + '\n';
function write(path: string, value: string | Uint8Array, base = project): void {
  mkdirSync(dirname(join(base, path)), { recursive: true });
  writeFileSync(join(base, path), value);
}
function read(path: string): Buffer {
  return readFileSync(join(project, path));
}
function publication(pass: ScenarioPublication['pass'] = 'scenes'): ScenarioPublication {
  return {
    project,
    pass,
    before: { cast, treatment, scenes },
    after: { cast, treatment, scenes: { ...scenes, scenes: scenes.scenes.map((scene) => ({ ...scene, action: 'Герой поворачивает голову.' })) } },
    expectedHashes: Object.fromEntries(
      ['plan/cast.json', 'plan/treatment.json', 'plan/scenes.json', 'source/description.md'].map((path) => [path, hash(read(path))])
    )
  };
}
function fakeLauncher(callback?: (stage: string, name: string, args: string[]) => Promise<ToolResult | void> | ToolResult | void): PythonLauncher {
  const run = vi.fn(async (stage: string, name: string, args: string[]) => {
    const custom = await callback?.(stage, name, args);
    return custom ?? { code: 0, stdout: '', stderr: '', command: name };
  });
  return { run } as unknown as PythonLauncher;
}
function pendingPath(): string {
  return join(localDir, 'scenario-apply', hash(project), 'pending.json');
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-apply-'));
  project = join(work, 'clip');
  localDir = join(work, 'state');
  cast = {
    schema_version: 1,
    properties: {},
    entities: [{ id: 'hero', kind: 'character', name: 'Герой', short_name: 'Герой', role: '', appearance: '', images: ['heroes/hero.png'], initial_state: {} }]
  };
  treatment = {
    schema_version: 1,
    logline: 'Герой в пути.',
    sequences: [{ id: 'intro', title: 'Вступление', direction: 'Начало пути.', start: 0, end: 1, entities: ['hero'], lipsync: false }]
  };
  scenes = {
    schema_version: 1,
    fps: 30,
    audio: { path: 'source/track.mp3', end_seconds: '1' },
    references: { hero: { name: 'Герой', path: 'source/heroes/hero.png' } },
    visual_direction: 'Пасмурный день.',
    sequences: [{ id: 'intro', title: 'Вступление', direction: 'Начало пути.' }],
    scenes: [
      {
        id: 'M01',
        original: 'Первая строка',
        sequence: 'intro',
        start_frame: 0,
        end_frame_exclusive: 30,
        camera: 'Общий план',
        action: 'Герой идёт.',
        continuity: '',
        references: ['hero'],
        lipsync: false,
        card: { primary_reference: 'hero' },
        state_from: null,
        state_changes: {}
      }
    ]
  };
  write('plan/cast.json', json(cast));
  write('plan/treatment.json', json(treatment));
  write('plan/scenes.json', json(scenes));
  write('plan/project.json', json({ schema_version: 1, name: 'Клип' }));
  write('plan/production-status.json', json({ current_animatic: 'plan/animatic/latest/manifest.json' }));
  write('plan/audio/timing.json', json({ duration_decoded: 1, status: 'Размечено', lines: [], sections: [] }));
  write('source/description.md', 'Герой отправляется в путь.');
  write('source/heroes/hero.png', Buffer.from([137, 80, 78, 71, 1]));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});

describe('публикация сценария', () => {
  it('семантический снимок допускает новую обложку, сохраняя проверку настоящих входов', async () => {
    const manifest = { schema_version: 1, cover: { path: 'cover.png' }, references: [{ id: 'hero' }], updated_at: 'до' };
    write('source/manifest.json', json(manifest));
    const input = publication('treatment');
    input.expectedHashes['source/manifest.json'] = sourceInputDigest(project);
    write('source/manifest.json', json({ ...manifest, cover: null, updated_at: 'после' }));
    await publishScenario(input, { localDir, launcher: fakeLauncher() });
    write('source/manifest.json', json({ ...manifest, references: [{ id: 'other' }] }));
    await expect(publishScenario(input, { localDir, launcher: fakeLauncher() })).rejects.toThrow('source/manifest.json');
  });

  it('первый проход публикует только пару и не обращается к Python', async () => {
    const input = publication('treatment');
    input.after.cast = { ...cast, entities: cast.entities.map((entity) => ({ ...entity, role: 'Главный герой' })) };
    input.after.treatment = { ...treatment, logline: 'Герой принимает решение.' };
    write('ROADMAP.md', 'Ручная версия');
    const launcher = fakeLauncher();
    const sceneBefore = read('plan/scenes.json');
    await publishScenario(input, { localDir, launcher });
    expect(read('plan/cast.json').toString()).toBe(json(input.after.cast));
    expect(read('plan/treatment.json').toString()).toBe(json(input.after.treatment));
    expect(read('plan/scenes.json')).toEqual(sceneBefore);
    expect(read('ROADMAP.md').toString()).toBe('Ручная версия');
    expect(launcher.run).not.toHaveBeenCalled();
    expect(existsSync(pendingPath())).toBe(false);
  });

  it('сначала проверяет ожидаемые хеши, включая отсутствие, и не запускает Python для устаревшего предложения', async () => {
    const input = publication();
    input.expectedHashes['source/new.txt'] = null;
    write('source/new.txt', 'Новый исходник');
    const launcher = fakeLauncher();
    await expect(publishScenario(input, { localDir, launcher })).rejects.toThrow(/устарело.*new.txt/);
    expect(launcher.run).not.toHaveBeenCalled();
    expect(read('plan/scenes.json').toString()).toBe(json(scenes));
  });

  it.each(['plan/animatic/cards/M02.png', 'assets/shots/M02/README.md'])('отклоняет новый производный файл %s между Start и Apply', async (path) => {
    const input = publication();
    for (const output of scenarioOutputPaths(project)) input.expectedHashes[output] = existsSync(join(project, output)) ? hash(read(output)) : null;
    expect(input.expectedHashes['ROADMAP.md']).toBeNull();
    expect(input.expectedHashes).not.toHaveProperty(path);
    write(path, 'Создано после запуска агента');
    const launcher = fakeLauncher();
    await expect(publishScenario(input, { localDir, launcher })).rejects.toThrow(/устарело.*производный файл/);
    expect(launcher.run).not.toHaveBeenCalled();
    expect(read('plan/scenes.json').toString()).toBe(json(scenes));
    expect(read(path).toString()).toBe('Создано после запуска агента');
  });

  it('проверяет изолированную копию, копирует принятое видео и публикует только известные выходы с удалениями', async () => {
    const accepted = Buffer.from([0, 1, 2, 255]);
    const manifest = { accepted_edit: { video: { path: 'accepted.mp4' } }, protected: 'Сохранить' };
    write('assets/shots/M01/manifest.json', json(manifest));
    write('assets/shots/M01/accepted.mp4', accepted);
    write('assets/shots/M01/original.mp4', 'Большой исходный оригинал');
    write('source/track.mp3', 'Исходный трек');
    write('plan/animatic/latest/full.mp4', 'Полный аниматик');
    write('plan/animatic/cards/obsolete.png', Buffer.from([0, 250]));
    write('.git/index', 'Git');
    const visited: { name: string; args: string[] }[] = [];
    let stageUsed = '';
    const launcher = fakeLauncher((stage, name, args) => {
      stageUsed = stage;
      expect(stage).not.toBe(project);
      expect(readFileSync(join(stage, 'source/heroes/hero.png'))).toEqual(read('source/heroes/hero.png'));
      expect(lstatSync(join(stage, 'source')).isSymbolicLink()).toBe(false);
      expect(readFileSync(join(stage, 'assets/shots/M01/accepted.mp4'))).toEqual(accepted);
      for (const absent of ['source/track.mp3', 'assets/shots/M01/original.mp4', 'plan/animatic/latest/full.mp4', '.git'])
        expect(existsSync(join(stage, absent))).toBe(false);
      visited.push({ name, args });
      if (name === 'update_scene_views' && !args.length) {
        write('ROADMAP.md', 'Новый ROADMAP', stage);
        write('plan/storyboard.md', 'Новая постановка', stage);
        write('assets/shots/manifest.json', '{"generated":true}', stage);
        write('assets/shots/M01/README.md', 'Представление принятого плана', stage);
        write('plan/animatic/cards/manifest.json', '{"cards":{}}', stage);
        write('plan/animatic/cards/M01.png', Buffer.from([137, 80, 78, 71, 255]), stage);
        rmSync(join(stage, 'plan/animatic/cards/obsolete.png'));
        write('source/description.md', 'Чужое изменение в staging', stage);
        write('assets/shots/M01/manifest.json', '{"protected":"не публиковать"}', stage);
      }
    });
    const input = publication('revise');
    await publishScenario(input, { localDir, launcher });
    expect(visited).toEqual([
      { name: 'lint_registry', args: [] },
      { name: 'continuity_brief', args: ['M01', '--phase', 'before', '--json'] },
      { name: 'continuity_brief', args: ['M01', '--phase', 'after', '--json'] },
      { name: 'update_scene_views', args: [] },
      { name: 'update_scene_views', args: ['--check'] }
    ]);
    expect(read('plan/scenes.json').toString()).toBe(json(input.after.scenes));
    expect(read('ROADMAP.md').toString()).toBe('Новый ROADMAP');
    expect(read('assets/shots/M01/manifest.json').toString()).toBe(json(manifest));
    expect(read('assets/shots/M01/accepted.mp4')).toEqual(accepted);
    expect(read('source/description.md').toString()).toBe('Герой отправляется в путь.');
    expect(read('plan/animatic/cards/M01.png')).toEqual(Buffer.from([137, 80, 78, 71, 255]));
    expect(existsSync(join(project, 'plan/animatic/cards/obsolete.png'))).toBe(false);
    expect(existsSync(stageUsed)).toBe(false);
    expect(existsSync(pendingPath())).toBe(false);
  });

  it.each(['lint_registry', 'continuity_brief', 'update_scene_views'])('ошибка %s не публикует изменения', async (failing) => {
    const before = read('plan/scenes.json');
    let stageUsed = '';
    const launcher = fakeLauncher((stage, name) => {
      stageUsed = stage;
      if (name === failing) return { code: 1, stdout: '', stderr: 'Проверка не пройдена', command: name };
    });
    await expect(publishScenario(publication(), { localDir, launcher })).rejects.toThrow(`проверка ${failing}`);
    expect(read('plan/scenes.json')).toEqual(before);
    expect(existsSync(stageUsed)).toBe(false);
    expect(existsSync(pendingPath())).toBe(false);
  });

  it('отдельная ошибка update_scene_views --check сохраняет рабочий проект', async () => {
    const launcher = fakeLauncher((stage, name, args) => {
      if (name === 'update_scene_views' && !args.length) write('ROADMAP.md', 'Результат проверки', stage);
      if (args.includes('--check')) return { code: 1, stdout: '', stderr: 'Устаревшие представления', command: name };
    });
    await expect(publishScenario(publication(), { localDir, launcher })).rejects.toThrow('Устаревшие представления');
    expect(read('plan/scenes.json').toString()).toBe(json(scenes));
    expect(existsSync(join(project, 'ROADMAP.md'))).toBe(false);
  });

  it.each(['metadata', 'image', 'new-input', 'new-output'])('выявляет изменение %s во время Python-проверок', async (change) => {
    const launcher = fakeLauncher((_stage, name, args) => {
      if (name === 'update_scene_views' && args.includes('--check')) {
        if (change === 'metadata') write('plan/production-status.json', '{"changed":true}');
        if (change === 'image') write('source/heroes/hero.png', Buffer.from([99]));
        if (change === 'new-input') write('assets/shots/M02/manifest.json', json({ accepted_edit: { video: { path: 'accepted.mp4' } } }));
        if (change === 'new-input') write('assets/shots/M02/accepted.mp4', Buffer.from([1]));
        if (change === 'new-output') write('plan/animatic/cards/new.png', Buffer.from([2]));
      }
    });
    await expect(publishScenario(publication(), { localDir, launcher })).rejects.toThrow(/устарело/);
    expect(read('plan/scenes.json').toString()).toBe(json(scenes));
    expect(existsSync(pendingPath())).toBe(false);
  });

  it('при отсутствии изменений не перезаписывает JSON и не создаёт pending', async () => {
    const input = publication('treatment');
    const writer = vi.spyOn(localFiles, 'writeAtomicBytes');
    await publishScenario(input, { localDir, launcher: fakeLauncher() });
    expect(writer).not.toHaveBeenCalled();
    expect(existsSync(join(localDir, 'scenario-apply'))).toBe(false);
  });

  it('восстанавливает оба прежних состояния при ошибке второй записи', async () => {
    const input = publication('treatment');
    input.after.cast = { ...cast, entities: cast.entities.map((entity) => ({ ...entity, role: 'Новая роль' })) };
    input.after.treatment = { ...treatment, logline: 'Новая трактовка' };
    const original = localFiles.writeAtomicBytes;
    let failed = false;
    vi.spyOn(localFiles, 'writeAtomicBytes').mockImplementation((path, data, mode) => {
      if (path === join(project, 'plan/treatment.json') && !failed) {
        failed = true;
        throw new Error('Сбой второй записи');
      }
      original(path, data, mode);
    });
    await expect(publishScenario(input, { localDir, launcher: fakeLauncher() })).rejects.toThrow('Сбой второй записи');
    expect(read('plan/cast.json').toString()).toBe(json(cast));
    expect(read('plan/treatment.json').toString()).toBe(json(treatment));
    expect(existsSync(pendingPath())).toBe(false);
  });

  it('восстанавливает удалённую карточку и убирает новые файлы при позднем сбое', async () => {
    const obsolete = Buffer.from([0, 255, 250]);
    write('plan/animatic/cards/obsolete.png', obsolete);
    write('plan/storyboard.md', 'Прежняя постановка');
    const launcher = fakeLauncher((stage, name, args) => {
      if (name === 'update_scene_views' && !args.length) {
        write('ROADMAP.md', 'Новый ROADMAP', stage);
        write('plan/storyboard.md', 'Новая постановка', stage);
        write('plan/animatic/cards/M01.png', Buffer.from([5]), stage);
        rmSync(join(stage, 'plan/animatic/cards/obsolete.png'));
      }
    });
    const original = localFiles.writeAtomicBytes;
    let failed = false;
    vi.spyOn(localFiles, 'writeAtomicBytes').mockImplementation((path, data, mode) => {
      if (path === join(project, 'plan/animatic/cards/M01.png') && !failed) {
        failed = true;
        throw new Error('Сбой записи карточки');
      }
      original(path, data, mode);
    });
    await expect(publishScenario(publication(), { localDir, launcher })).rejects.toThrow('Сбой записи карточки');
    expect(read('plan/scenes.json').toString()).toBe(json(scenes));
    expect(read('plan/storyboard.md').toString()).toBe('Прежняя постановка');
    expect(read('plan/animatic/cards/obsolete.png')).toEqual(obsolete);
    expect(existsSync(join(project, 'ROADMAP.md'))).toBe(false);
    expect(existsSync(join(project, 'plan/animatic/cards/M01.png'))).toBe(false);
  });

  it('сохраняет pending при ошибке отката и завершает восстановление при следующем запуске', async () => {
    const input = publication('treatment');
    input.after.cast = { ...cast, entities: cast.entities.map((entity) => ({ ...entity, role: 'Новая роль' })) };
    input.after.treatment = { ...treatment, logline: 'Новая трактовка' };
    const original = localFiles.writeAtomicBytes;
    let castWritten = false;
    const writer = vi.spyOn(localFiles, 'writeAtomicBytes').mockImplementation((path, data, mode) => {
      if (path === join(project, 'plan/cast.json')) {
        if (castWritten) throw new Error('Не удалось вернуть кастинг');
        castWritten = true;
      }
      if (path === join(project, 'plan/treatment.json')) throw new Error('Сбой записи трактовки');
      original(path, data, mode);
    });
    await expect(publishScenario(input, { localDir, launcher: fakeLauncher() })).rejects.toThrow('Восстановление не завершено');
    expect(existsSync(pendingPath())).toBe(true);
    expect(readdirSync(dirname(pendingPath()))).toContain('0.bak');
    writer.mockRestore();
    recoverScenarioApplications(localDir);
    expect(read('plan/cast.json').toString()).toBe(json(cast));
    expect(read('plan/treatment.json').toString()).toBe(json(treatment));
    expect(existsSync(pendingPath())).toBe(false);
    expect(() => recoverScenarioApplications(localDir)).not.toThrow();
  });

  it('recovery возвращает прежние байты и отсутствие после аварийного обрыва', () => {
    const pending = pendingPath();
    mkdirSync(dirname(pending), { recursive: true });
    writeFileSync(join(dirname(pending), '0.bak'), Buffer.from([0, 255, 12]));
    write('plan/animatic/cards/M01.png', 'Новая карточка');
    write('ROADMAP.md', 'Впервые созданный файл');
    writeFileSync(
      pending,
      json({
        schemaVersion: 1,
        project,
        files: [
          { path: 'plan/animatic/cards/M01.png', backup: '0.bak', mode: 0o640 },
          { path: 'ROADMAP.md', backup: null }
        ]
      })
    );
    recoverScenarioApplications(localDir);
    expect(read('plan/animatic/cards/M01.png')).toEqual(Buffer.from([0, 255, 12]));
    expect(lstatSync(join(project, 'plan/animatic/cards/M01.png')).mode & 0o777).toBe(0o640);
    expect(existsSync(join(project, 'ROADMAP.md'))).toBe(false);
    expect(existsSync(pending)).toBe(false);
  });

  it.each(['missing', 'moved', 'marker'])('сохраняет pending и резервы при недоступном проекте: %s', (state) => {
    const pending = pendingPath();
    mkdirSync(dirname(pending), { recursive: true });
    const original = Buffer.from('Прежний кастинг');
    writeFileSync(join(dirname(pending), '0.bak'), original);
    write('plan/cast.json', 'Частично применённый кастинг');
    writeFileSync(pending, json({ schemaVersion: 1, project, files: [{ path: 'plan/cast.json', backup: '0.bak' }] }));
    const moved = join(work, 'moved-clip');
    if (state === 'missing') rmSync(project, { recursive: true });
    if (state === 'moved') renameSync(project, moved);
    if (state === 'marker') rmSync(join(project, 'plan/project.json'));
    expect(() => recoverScenarioApplications(localDir)).toThrow(/Проект недоступен.*plan\/project.json/);
    expect(existsSync(pending)).toBe(true);
    expect(readFileSync(join(dirname(pending), '0.bak'))).toEqual(original);
    if (state !== 'marker') expect(existsSync(project)).toBe(false);
    if (state === 'marker') expect(read('plan/cast.json').toString()).toBe('Частично применённый кастинг');
    if (state === 'moved') expect(readFileSync(join(moved, 'plan/cast.json'), 'utf8')).toBe('Частично применённый кастинг');
  });

  it('ошибка старого пути не мешает восстановить остальные проекты', () => {
    const stalePending = pendingPath();
    mkdirSync(dirname(stalePending), { recursive: true });
    writeFileSync(join(dirname(stalePending), '0.bak'), 'Сохранить резерв');
    writeFileSync(stalePending, json({ schemaVersion: 1, project, files: [{ path: 'plan/cast.json', backup: '0.bak' }] }));
    rmSync(project, { recursive: true });
    const otherProject = join(work, 'other-clip');
    write('plan/project.json', json({ schema_version: 1, name: 'Другой клип' }), otherProject);
    write('plan/scenes.json', 'Частичная запись', otherProject);
    const otherPending = join(localDir, 'scenario-apply', hash(otherProject), 'pending.json');
    mkdirSync(dirname(otherPending), { recursive: true });
    writeFileSync(join(dirname(otherPending), '0.bak'), 'Прежний реестр другого клипа');
    writeFileSync(otherPending, json({ schemaVersion: 1, project: otherProject, files: [{ path: 'plan/scenes.json', backup: '0.bak' }] }));
    expect(() => recoverScenarioApplications(localDir)).toThrow('Проект недоступен');
    expect(existsSync(stalePending)).toBe(true);
    expect(existsSync(otherPending)).toBe(false);
    expect(readFileSync(join(otherProject, 'plan/scenes.json'), 'utf8')).toBe('Прежний реестр другого клипа');
    expect(existsSync(project)).toBe(false);
  });

  it('не восстанавливает произвольные исходники из повреждённого pending', () => {
    const pending = pendingPath();
    mkdirSync(dirname(pending), { recursive: true });
    writeFileSync(join(dirname(pending), '0.bak'), 'Не применять');
    writeFileSync(pending, json({ schemaVersion: 1, project, files: [{ path: 'source/description.md', backup: '0.bak' }] }));
    expect(() => recoverScenarioApplications(localDir)).toThrow('недопустимые пути');
    expect(read('source/description.md').toString()).toBe('Герой отправляется в путь.');
    expect(existsSync(pending)).toBe(true);
  });

  it('не использует символические ссылки вместо staging-материалов', async () => {
    const outside = join(work, 'outside');
    mkdirSync(outside);
    symlinkSync(outside, join(project, 'assets'));
    await expect(publishScenario(publication(), { localDir, launcher: fakeLauncher() })).rejects.toThrow('без ссылки');
    expect(read('plan/scenes.json').toString()).toBe(json(scenes));
  });
});

it.each([
  [{ code: 2, stdout: '', stderr: '  ошибка «пути» source/реф A.png  ' }, 'Не пройдена проверка lint_registry: ошибка «пути» source/реф A.png'],
  [{ code: 5, stdout: '  выход stdout  ', stderr: '' }, 'Не пройдена проверка lint_registry: выход stdout'],
  [{ code: 11, stdout: '', stderr: '' }, 'Не пройдена проверка lint_registry: код 11'],
  [{ code: null, stdout: '', stderr: '' }, 'Не пройдена проверка lint_registry: код null']
])('сохраняет приоритет и полный текст ошибки локальной проверки: %j', async (result, expected) => {
  const launcher = fakeLauncher(() => ({ ...result, command: 'lint_registry' }));
  await expect(publishScenario(publication(), { localDir, launcher })).rejects.toThrow(new Error(expected));
  expect(existsSync(pendingPath())).toBe(false);
});

it('не читает stdout при наличии stderr и обрезает прежний хвост ошибки', async () => {
  const launcher = fakeLauncher(() => ({
    code: 2,
    command: 'lint_registry',
    stderr: `  ${'x'.repeat(1250)}ошибка  `,
    get stdout(): string {
      throw new Error('stdout не должен читаться');
    }
  }));
  await expect(publishScenario(publication(), { localDir, launcher })).rejects.toThrow(
    new Error(`Не пройдена проверка lint_registry: ${'x'.repeat(1194)}ошибка`)
  );
});

it('сохраняет путь и кавычки в публичной ошибке устаревшего снимка', async () => {
  const path = 'source/референс «А» с пробелами.png';
  write(path, 'исходный образ');
  const input = publication();
  input.expectedHashes![path] = hash('другой образ');
  await expect(publishScenario(input, { localDir, launcher: fakeLauncher() })).rejects.toThrow(
    new Error('Предложение устарело: изменился source/референс «А» с пробелами.png. Подготовьте новое предложение.')
  );
});
