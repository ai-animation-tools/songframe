/** Тесты логики главного процесса без Electron: статус проекта, шаблон, исходники, пути. */

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CastFile, JobInfo, ProjectSettings, ScenesFile } from '@shared/types';
import { findToolsRoot, resolvePaths } from './paths';
import { defaultAnimaticName, Projects, validateNewProject } from './projects';
import { parseLyrics, readManifest, saveSources, validateSources } from './sources';
import { LocalState } from './state';
import { resolvePython } from './python-runtime';
import { PythonLauncher } from './python-launcher';
import { computeStatus, sha256Text } from './status';
import { renderPlaceholders } from './template';
import { stampAcceptedShots } from './testing/accepted-shots';

const REPO = resolve(__dirname, '../..');
let work: string;

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-test-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function writeJson(path: string, data: unknown): void {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(data, null, 2));
}

describe('paths', () => {
  it('находит корень комплекса от вложенной папки и даёт userData без него', () => {
    expect(findToolsRoot([join(REPO, 'src', 'main')])).toBe(REPO);
    expect(findToolsRoot([work])).toBeNull();
    const paths = resolvePaths({ appPath: work, execPath: join(work, 'app'), cwd: work, userData: join(work, 'ud') });
    expect(paths).toMatchObject({ toolsRoot: null, resourcesRoot: null, runtimeRoot: null, localDir: join(work, 'ud') });
    expect(resolvePaths({ appPath: work, execPath: work, cwd: work, userData: work, override: REPO }).toolsRoot).toBe(REPO);
  });
});

function markdownFiles(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((item) => {
    const file = join(path, item.name);
    return item.isDirectory() ? markdownFiles(file) : item.name.endsWith('.md') ? [file] : [];
  });
}

describe('template', () => {
  it('подставляет плейсхолдеры', () => {
    expect(renderPlaceholders('«{{project_name}}» в {{ animatic_video }} {{unknown}}', { project_name: 'Клип', animatic_video: 'a.mp4' })).toBe(
      '«Клип» в a.mp4 {{unknown}}'
    );
  });

  it('справки шаблона ссылаются только на файлы внутри проекта и не описывают ручной запуск инструментов', () => {
    const root = join(REPO, 'templates/project');
    // Эти файлы приложение создаёт позже: исходники, разметка, сценарий, представления и сборка.
    const futureOutputs = new Set([
      'source/manifest.json',
      'plan/audio/timing.json',
      'plan/scenes.json',
      'plan/edit-list.md',
      'plan/storyboard.md',
      'plan/context/characters.md',
      'plan/audio/timing.md',
      'plan/animatic/latest/manifest.json'
    ]);
    const missing: string[] = [];
    for (const file of markdownFiles(root)) {
      const content = readFileSync(file, 'utf8');
      expect(content, file).not.toMatch(/\.songframe|run-tool|AGENTS\.md|songframe-tool/);
      for (const link of content.matchAll(/(?<!!)\[[^\]\n]+\]\(([^)\n]+)\)/g)) {
        if (/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(link[1])) continue;
        const target = resolve(join(file, '..'), decodeURIComponent(link[1].split(/[?#]/)[0]));
        const inside = target.slice(root.length + 1);
        if (!target.startsWith(root + '/') || (!existsSync(target) && !futureOutputs.has(inside))) missing.push(`${file.slice(root.length + 1)} → ${link[1]}`);
      }
    }
    expect(missing).toEqual([]);
  });
});

describe('status', () => {
  it('выводит состояние из файлов проекта', () => {
    expect(computeStatus(work).state).toBe('invalid');
    writeJson(join(work, 'plan/project.json'), { schema_version: 1, name: 'Проба', animatic_video: 'clip.mp4' });
    expect(computeStatus(work)).toMatchObject({ state: 'empty', name: 'Проба', animaticVideo: 'clip.mp4' });
    writeJson(join(work, 'source/manifest.json'), {
      schema_version: 1,
      track: { path: 'track.mp3' },
      lyrics: { path: 'text.md' },
      idea: { path: 'description.md' },
      references: []
    });
    expect(computeStatus(work).state).toBe('sourced');
    writeJson(join(work, 'plan/audio/timing.json'), { lines: [{ id: 1 }] });
    expect(computeStatus(work).state).toBe('timed');
    const scenes = JSON.stringify({ scenes: [{ id: 'M01' }, { id: 'M02' }] });
    writeFileSync(join(work, 'plan/scenes.json'), scenes);
    expect(computeStatus(work)).toMatchObject({ state: 'scripted', checks: { shotsTotal: 2, shotsDone: 0 } });
    writeJson(join(work, 'assets/shots/M01/manifest.json'), { shot: 'M01' });
    // Комплект без принятого отпечатка постановки не считается готовым.
    expect(computeStatus(work)).toMatchObject({ state: 'in_production', checks: { shotsDone: 0 } });
    expect(computeStatus(work).problems).toContain('Постановка изменена после приёмки: M01. Нужно новое производство этих планов.');
    stampAcceptedShots(work, ['M01']);
    expect(computeStatus(work)).toMatchObject({ state: 'in_production', checks: { shotsDone: 1 } });
    writeJson(join(work, 'assets/shots/M02/manifest.json'), { shot: 'M02' });
    stampAcceptedShots(work, ['M02']);
    const all = computeStatus(work);
    expect(all.state).toBe('in_production');
    expect(all.problems[0]).toMatch(/не собран/);
    writeFileSync(join(work, 'source/track.mp3'), 'track');
    for (const id of ['M01', 'M02']) {
      writeFileSync(join(work, 'assets/shots', id, 'video.mp4'), 'video');
      writeJson(join(work, 'assets/shots', id, 'manifest.json'), {
        shot: id,
        accepted_edit: { fps: 30, frames: 60, video: { path: 'video.mp4', sha256: sha256Text('video') } }
      });
    }
    const latest = join(work, 'plan/animatic/latest');
    mkdirSync(latest, { recursive: true });
    writeFileSync(join(latest, 'clip.mp4'), 'mp4');
    const built = {
      video_file: 'clip.mp4',
      video_sha256: sha256Text('mp4'),
      project_inputs: { name: JSON.parse(readFileSync(join(work, 'plan/project.json'), 'utf8')).name, animatic_video: 'clip.mp4' },
      source_hashes: { 'source/track.mp3': sha256Text('track') },
      shots: ['M01', 'M02'].map((id) => ({ id, frames: 60, media: 'video', path: `assets/shots/${id}/video.mp4`, sha256: sha256Text('video') }))
    };
    writeJson(join(latest, 'manifest.json'), { ...built, scene_registry_sha256: 'stale' });
    expect(computeStatus(work).problems[0]).toMatch(/устаревшему/);
    writeJson(join(latest, 'manifest.json'), { ...built, scene_registry_sha256: sha256Text(scenes) });
    expect(computeStatus(work).problems[0]).toMatch(/не принят/);
    const status = JSON.parse(readFileSync(join(work, 'plan/production-status.json'), 'utf8'));
    writeJson(join(work, 'plan/production-status.json'), {
      ...status,
      current_animatic_status: 'approved',
      approved_animatic: { video_sha256: sha256Text('mp4') }
    });
    expect(computeStatus(work)).toMatchObject({ state: 'complete', problems: [] });
  });

  it('сообщает о битых файлах, не падая', () => {
    writeJson(join(work, 'plan/project.json'), { name: 'X' });
    mkdirSync(join(work, 'source'));
    writeFileSync(join(work, 'source/manifest.json'), '{');
    writeFileSync(join(work, 'plan/scenes.json'), 'not json');
    const status = computeStatus(work);
    expect(status.state).toBe('empty');
    expect(status.problems).toHaveLength(2);
  });
});

describe('projects', () => {
  it('переименовывает проект без generation, сохраняя остальные данные и порядок истории', () => {
    const target = join(work, 'проект');
    const marker = { schema_version: 1, name: 'Старое название', animatic_video: 'original.mp4', custom: { value: 42 } };
    writeJson(join(target, 'plan/project.json'), marker);
    mkdirSync(join(target, 'source'));
    writeFileSync(join(target, 'source/original.txt'), 'Оригинал');
    const state = new LocalState(join(work, 'state'));
    state.writeCurrent(target);
    state.touchHistory(target, marker.name);
    state.touchHistory(join(work, 'другой'), 'Другой проект');
    const before = state.readHistory();
    const projects = new Projects(state, REPO, 'linux');

    expect(projects.rename(target, '  Новое название  ')).toMatchObject({ name: 'Новое название', path: target, animaticVideo: 'original.mp4' });
    expect(JSON.parse(readFileSync(join(target, 'plan/project.json'), 'utf8'))).toEqual({ ...marker, name: 'Новое название' });
    expect(state.readHistory()).toEqual(before.map((entry) => (entry.path === target ? { ...entry, name: 'Новое название' } : entry)));
    expect(state.readCurrent()).toBe(target);
    expect(readFileSync(join(target, 'source/original.txt'), 'utf8')).toBe('Оригинал');

    const saved = readFileSync(join(target, 'plan/project.json'), 'utf8');
    expect(() => projects.rename(target, '  ')).toThrow(/не может быть пустым/);
    expect(readFileSync(join(target, 'plan/project.json'), 'utf8')).toBe(saved);
  });

  it('создаёт проект из шаблона, пишет текущий проект и историю', () => {
    const state = new LocalState(join(work, 'local'));
    const projects = new Projects(state, REPO, 'linux');
    const target = join(work, 'clips', 'new-clip');
    mkdirSync(join(work, 'clips'));
    expect(validateNewProject({ name: '', path: 'relative' })).toHaveLength(2);
    expect(validateNewProject({ name: 'Клип', path: target })).toEqual([]);
    const status = projects.create({ name: 'Новый клип', path: target });
    expect(status.state).toBe('empty');
    expect(JSON.parse(readFileSync(join(target, 'plan/project.json'), 'utf-8'))).toMatchObject({
      schema_version: 1,
      name: 'Новый клип',
      animatic_video: 'animatic.mp4',
      generation: { video: null, image: null }
    });
    const readme = readFileSync(join(target, 'README.md'), 'utf-8');
    expect(readme).toContain('«Новый клип»');
    expect(readme).not.toContain(REPO);
    expect(readme).not.toContain('{{');
    for (const absent of ['AGENTS.md', '.vscode', '.songframe', '.agents', '.claude']) expect(existsSync(join(target, absent)), absent).toBe(false);
    expect(existsSync(join(target, '.git'))).toBe(true);
    expect(existsSync(join(target, 'plan/batches/.gitkeep'))).toBe(true);
    expect(state.readCurrent()).toBe(target);
    expect(projects.appState().history[0]).toMatchObject({ path: target, name: 'Новый клип', exists: true });
    expect(validateNewProject({ name: 'Ещё', path: target })[0]).toMatch(/уже существует/);
    expect(defaultAnimaticName('My Clip!')).toBe('my-clip-animatic.mp4');
    expect(defaultAnimaticName('Лев')).toBe('animatic.mp4');

    // Повторное открытие не переписывает файлы проекта.
    writeFileSync(join(target, 'README.md'), readme + '\nМоя заметка\n');
    projects.open(target);
    expect(readFileSync(join(target, 'README.md'), 'utf-8')).toBe(readme + '\nМоя заметка\n');

    projects.forget(target);
    expect(state.readCurrent()).toBeNull();
    expect(state.readHistory()).toEqual([]);
    expect(() => projects.open(join(work, 'nowhere'))).toThrow(/plan\/project.json/);
  });
});

describe('sources', () => {
  it('разбирает текст песни по строкам и частям', () => {
    const parsed = parseLyrics('[Куплет 1]\nстрока 1\nстрока 2\n\n[Припев]\nстрока 3\n');
    expect(parsed).toEqual({ lines: 3, sections: ['Куплет 1', 'Припев'], problems: [] });
    expect(parseLyrics('[Припев]\n').problems).toHaveLength(1);
    expect(parseLyrics('Куплет 1\nстрока\nПрипев:\nФинальный припев\nПрипев 2 раза\nстрока').problems[0]).toMatch(
      /«Куплет 1», «Припев:», «Финальный припев», «Припев 2 раза»/
    );
    expect(parseLyrics('Солнце проснулось над тихой рекой\nПрипев этот мы поём вчетвером\n').problems).toEqual([]);
  });

  it('проверяет и сохраняет исходники, затем обновляет их без потери сохранённого', () => {
    const project = join(work, 'clip');
    writeJson(join(project, 'plan/project.json'), { name: 'Клип' });
    const track = join(work, 'song.mp3');
    writeFileSync(track, 'not really mp3');
    const png = join(work, 'hero.png');
    writeFileSync(png, 'png bytes');
    const png2 = join(work, 'hero-face.jpeg');
    writeFileSync(png2, 'png bytes 2');

    expect(validateSources(project, { track: null, lyrics: null, idea: null, cover: null, references: [] })).toEqual([
      'Трек обязателен.',
      'Текст песни обязателен.',
      'Идея клипа обязательна.'
    ]);
    const bad = validateSources(project, {
      track: { path: track },
      lyrics: { text: '[Припев]' },
      idea: { text: 'идея' },
      cover: null,
      references: [{ id: 'Мира', kind: 'character', name: '', short_name: '', description: '', prompt: '', files: [] }]
    });
    expect(bad.join(' ')).toMatch(/ни одной строки/);
    expect(bad.join(' ')).toMatch(/Код референса/);
    expect(bad.join(' ')).toMatch(/нет названия/);
    expect(bad.join(' ')).toMatch(/ни одного изображения/);

    const manifest = saveSources(project, {
      track: { path: track },
      lyrics: { text: '[Куплет]\nпервая\nвторая\r\n' },
      idea: { text: 'Герой запускает фонарик' },
      cover: { path: png },
      references: [
        {
          id: 'mira',
          kind: 'character',
          name: 'Мира',
          short_name: '',
          description: 'главный герой',
          prompt: 'промпт Миры',
          files: [
            { sourcePath: png, view: 'full', note: '' },
            { sourcePath: png2, view: 'face', note: 'крупно' }
          ]
        },
        { id: 'boat', kind: 'vehicle', name: 'Лодка', short_name: 'Лодка', description: '', prompt: '', files: [{ sourcePath: png, view: 'side', note: '' }] }
      ]
    });
    expect(manifest.track).toMatchObject({ path: 'track.mp3', original_name: 'song.mp3', bytes: 14 });
    expect(manifest.lyrics).toMatchObject({ path: 'text.md', lines: 2, sections: ['Куплет'] });
    expect(readFileSync(join(project, 'source/text.md'), 'utf-8')).toBe('[Куплет]\nпервая\nвторая\n');
    expect(manifest.cover?.path).toBe('cover.png');
    expect(manifest.references[0]).toMatchObject({ id: 'mira', short_name: 'Мира', prompt: 'heroes/mira.prompt.txt' });
    expect(manifest.references[0].files.map((f) => f.path)).toEqual(['heroes/mira.png', 'heroes/mira-2.jpg']);
    expect(manifest.references[1].files[0].path).toBe('vehicles/boat.png');
    expect(readFileSync(join(project, 'source/heroes/mira.prompt.txt'), 'utf-8')).toBe('промпт Миры\n');
    expect(computeStatus(project).state).toBe('sourced');

    // Повторное сохранение: трек и идея остаются, лодка удалена вместе с файлом, лицо Миры сохранено как существующее.
    const dogPng = join(work, 'dog.png');
    writeFileSync(dogPng, 'dog');
    const withAnimal = saveSources(project, {
      kinds: [...(manifest.kinds ?? []), { id: 'animal', label: 'Животное', dir: 'animals' }],
      track: null,
      lyrics: null,
      idea: null,
      cover: null,
      references: [
        {
          id: 'mira',
          kind: 'character',
          name: 'Мира',
          short_name: '',
          description: '',
          prompt: '',
          files: [
            { existingPath: 'heroes/mira.png', view: 'full', note: '' },
            { existingPath: 'heroes/mira-2.jpg', view: 'face', note: '' }
          ]
        },
        { id: 'dog', kind: 'animal', name: 'Пёс', short_name: 'Пёс', description: '', prompt: '', files: [{ sourcePath: dogPng, view: 'full', note: '' }] }
      ]
    });
    expect(withAnimal.kinds?.map((k) => k.id)).toEqual(['character', 'vehicle', 'location', 'prop', 'style', 'animal']);
    expect(withAnimal.references[1].files[0].path).toBe('animals/dog.png');
    expect(
      validateSources(project, { kinds: [{ id: 'Bad', label: '', dir: 'x y' }], track: null, lyrics: null, idea: null, cover: null, references: [] })
    ).toHaveLength(3);

    const second = saveSources(
      project,
      {
        track: null,
        lyrics: null,
        idea: null,
        cover: { remove: true },
        references: [
          {
            id: 'mira',
            kind: 'character',
            name: 'Мира',
            short_name: 'П',
            description: '',
            prompt: '',
            files: [{ existingPath: 'heroes/mira-2.jpg', view: 'face', note: '' }]
          }
        ]
      },
      'ffprobe'
    );
    expect(second.track?.sha256).toBe(manifest.track?.sha256);
    expect(second.cover).toBeNull();
    expect(existsSync(join(project, 'source/cover.png'))).toBe(false);
    expect(existsSync(join(project, 'source/vehicles/boat.png'))).toBe(false);
    expect(existsSync(join(project, 'source/heroes/mira.png'))).toBe(false);
    expect(existsSync(join(project, 'source/heroes/mira.prompt.txt'))).toBe(false);
    expect(existsSync(join(project, 'source/heroes/mira-2.jpg'))).toBe(true);
    expect(existsSync(join(project, 'source/animals/dog.png'))).toBe(false);
    expect(readManifest(project)?.references[0].files).toHaveLength(1);
    expect(readManifest(project)?.kinds?.length).toBe(6);
  });
});

describe('инструменты комплекса видят созданный проект', () => {
  it('current_project show читает файл, записанный приложением', () => {
    const state = new LocalState(join(work, 'local'));
    const project = join(work, 'clip');
    new Projects(state, REPO, 'linux').create({ name: 'Клип', path: project });
    const run = (env: NodeJS.ProcessEnv): { status: number | null; data: Record<string, unknown> } => {
      const result = spawnSync(resolvePython({ toolsRoot: REPO }).command, ['-B', join(REPO, 'tools/current_project/current_project.py'), '--json', 'show'], {
        encoding: 'utf-8',
        env: { ...process.env, ...env },
        cwd: work
      });
      return { status: result.status, data: JSON.parse(result.stdout) as Record<string, unknown> };
    };
    // Файл приложения лежит во временной папке, поэтому инструменту проект передаётся переменной окружения.
    expect(run({ SONGFRAME_PROJECT: work }).data).toMatchObject({ is_project: false, source: 'environment' });
    const viaEnv = run({ SONGFRAME_PROJECT: state.readCurrent()! });
    expect(viaEnv.status).toBe(0);
    expect(viaEnv.data).toMatchObject({ is_project: true, name: 'Клип', source: 'environment' });
  });
});

describe('cast и сценарий', () => {
  const cast = (): CastFile => ({
    schema_version: 1,
    entities: [
      { id: 'world', kind: 'world', name: 'Мир', short_name: 'Мир', role: '', appearance: '', images: [], initial_state: { weather: 'пасмурно' } },
      {
        id: 'mira',
        kind: 'character',
        name: 'Мира',
        short_name: 'Мира',
        role: '',
        appearance: '',
        images: ['heroes/mira.jpg'],
        initial_state: { clothes_condition: 'чистая' }
      },
      { id: 'boat', kind: 'vehicle', name: 'Лодка', short_name: 'Лодка', role: '', appearance: '', images: ['vehicles/boat.png'], initial_state: {} }
    ],
    properties: {
      world: [{ key: 'weather', label: 'Погода', checklist: 'Погода: {value}?' }],
      character: [{ key: 'clothes_condition', label: 'Одежда', checklist: 'Одежда: {value}?' }],
      vehicle: [{ key: 'orientation', label: 'Ориентация', checklist: 'Транспорт стоит {value}, не у берега?' }]
    }
  });
  const scenes = (): ScenesFile => ({
    schema_version: 1,
    fps: 30,
    audio: { path: 'source/track.mp3', end_seconds: '3' },
    references: { mira: { name: 'Мира', path: 'source/heroes/mira.jpg' }, boat: { name: 'Лодка', path: 'source/vehicles/boat.png' } },
    visual_direction: 'правила',
    sequences: [{ id: 's', title: 'С', direction: '' }],
    scenes: [
      {
        id: 'M01',
        original: '',
        sequence: 's',
        start_frame: 0,
        end_frame_exclusive: 30,
        camera: 'к',
        action: 'Плывут',
        continuity: '',
        references: ['mira'],
        lipsync: false,
        card: { primary_reference: 'mira' },
        state_from: null,
        state_changes: { after: { mira: { clothes_condition: 'брызги' } } }
      },
      {
        id: 'M02',
        original: '',
        sequence: 's',
        start_frame: 30,
        end_frame_exclusive: 60,
        camera: 'к',
        action: 'Останавливаются',
        continuity: '',
        references: ['boat'],
        lipsync: false,
        card: { primary_reference: 'boat' },
        state_from: 'M01',
        state_changes: { before: { boat: { orientation: 'у причала' } }, after: { mira: { clothes_condition: null } } }
      },
      {
        id: 'M03',
        original: '',
        sequence: 's',
        start_frame: 60,
        end_frame_exclusive: 90,
        camera: 'к',
        action: 'Повтор',
        continuity: '',
        references: ['—'],
        lipsync: false,
        card: { primary_reference: 'boat' },
        state_from: { scene: 'M01', phase: 'same' },
        state_changes: {}
      }
    ]
  });

  it('кастинг собирается из исходников и даёт references и начальное состояние', async () => {
    const { castFromSources, castReferences, initialStates, validateCast, loadDefaults } = await import('./cast');
    const defaults = loadDefaults(REPO);
    expect(Object.keys(defaults.default)).toContain('vehicle');
    const manifest = {
      schema_version: 1 as const,
      kinds: [{ id: 'animal', label: 'Животное', dir: 'animals' }],
      track: null,
      lyrics: null,
      idea: null,
      cover: null,
      updated_at: '',
      references: [
        {
          id: 'mira',
          kind: 'character',
          name: 'Мира',
          short_name: 'Мира',
          description: 'светлый плащ',
          prompt: null,
          files: [{ path: 'heroes/mira.jpg', sha256: '', bytes: 1, view: 'full' as const, note: '' }]
        },
        {
          id: 'dog',
          kind: 'animal',
          name: 'Пёс',
          short_name: 'Пёс',
          description: '',
          prompt: null,
          files: [{ path: 'animals/dog.png', sha256: '', bytes: 1, view: 'full' as const, note: '' }]
        }
      ]
    };
    const built = castFromSources(manifest, null, defaults);
    expect(built.entities.map((e) => e.id)).toEqual(['world', 'mira', 'dog']);
    expect(built.entities[1].appearance).toBe('светлый плащ');
    expect(built.properties.animal.map((p) => p.key)).toEqual(['position', 'condition', 'marks', 'note']);
    expect(validateCast(built)).toEqual([]);
    expect(castReferences(cast())).toEqual({
      mira: { name: 'Мира', path: 'source/heroes/mira.jpg' },
      boat: { name: 'Лодка', path: 'source/vehicles/boat.png' }
    });
    expect(initialStates(cast())).toEqual({ world: { weather: 'пасмурно' }, mira: { clothes_condition: 'чистая' } });
    expect(validateCast({ ...built, entities: [...built.entities, { ...built.entities[1], id: 'Bad id' }] }).join(' ')).toMatch(/латиница/);
  });

  it('состояние наследуется как в scene_registry и попадает во врезку', async () => {
    const { resolveStates, validateScenes, buildBrief, validateTreatment } = await import('./scenario');
    const { initialStates } = await import('./cast');
    const states = resolveStates(scenes(), initialStates(cast()));
    expect(states.M01.before).toEqual({ world: { weather: 'пасмурно' }, mira: { clothes_condition: 'чистая' } });
    expect(states.M01.after.mira).toEqual({ clothes_condition: 'брызги' });
    expect(states.M02.before.boat).toEqual({ orientation: 'у причала' });
    expect(states.M02.after.mira).toBeUndefined();
    expect(states.M03).toEqual(states.M01);
    expect(validateScenes(scenes(), cast())).toEqual([]);
    const broken = scenes();
    broken.scenes[1].start_frame = 31;
    broken.scenes[1].references = ['unknown_ref'];
    expect(validateScenes(broken, cast()).join(' ')).toMatch(/не совпадает.*неизвестный референс unknown_ref/);
    const cyclic = scenes();
    cyclic.scenes[0].state_from = 'M02';
    expect(validateScenes(cyclic, cast()).join(' ')).toMatch(/Цикл/);
    // Производный план ссылается на существующий план с собственной генерацией; пустое значение редактора допустимо.
    const derived = scenes();
    derived.scenes[2].derived_from = { shot: 'M01' };
    derived.scenes[1].derived_from = undefined;
    expect(validateScenes(derived, cast())).toEqual([]);
    const derivedProblems = (shots: Partial<Record<'M01' | 'M02' | 'M03', unknown>>): string => {
      const value = scenes();
      for (const scene of value.scenes) if (scene.id in shots) Object.assign(scene, { derived_from: shots[scene.id as 'M01'] });
      return validateScenes(value, cast()).join(' ');
    };
    expect(derivedProblems({ M03: { shot: 'M99' } })).toBe('M03: derived_from ссылается на неизвестный план M99.');
    expect(derivedProblems({ M03: { shot: 'M03' } })).toBe('M03: derived_from не может ссылаться на сам план.');
    expect(derivedProblems({ M02: { shot: 'M01' }, M03: { shot: 'M02' } })).toBe('M03: источник M02 сам собирается из другого плана; укажите исходный план.');
    expect(derivedProblems({ M03: 'M01' })).toBe('M03: derived_from должен быть объектом {"shot": "Mxx"}.');
    expect(derivedProblems({ M03: { shot: 'M01', mode: 'still' } })).toBe('M03: derived_from должен быть объектом {"shot": "Mxx"}.');
    const brief = buildBrief(scenes(), cast(), 'M02', 'before', REPO);
    expect(brief.text.split('\n')[2]).toBe('Мир: погода: пасмурно.');
    expect(brief.checklist).toEqual(['Мир: Погода: пасмурно?', 'Мира: Одежда: брызги?', 'Лодка: Транспорт стоит у причала, не у берега?']);
    expect(buildBrief(scenes(), null, 'M01', 'after', REPO).text).toContain('mira: clothes condition: брызги.');
    expect(
      validateTreatment(
        {
          schema_version: 1,
          logline: '',
          sequences: [
            { id: 'a', title: 'А', direction: '', start: 0, end: 10, entities: [] },
            { id: 'b', title: 'Б', direction: '', start: 10.5, end: 20, entities: [] }
          ]
        },
        21
      ).join(' ')
    ).toMatch(/не стыкуется.*трек длится/);
  });
});

describe('производство', () => {
  it('читает пакеты планов: этап, кандидаты опор, вопрос, попытку и результат', async () => {
    const { viewProduction } = await import('./production');
    const project = join(work, 'clip');
    writeJson(join(project, 'plan/project.json'), { schema_version: 1, name: 'Клип', animatic_video: 'a.mp4' });
    writeJson(join(project, 'plan/scenes.json'), {
      schema_version: 1,
      fps: 30,
      audio: { path: 'source/track.mp3', end_seconds: '4' },
      references: { mira: { name: 'Мира', path: 'source/heroes/mira.jpg' } },
      visual_direction: 'x',
      sequences: [{ id: 's', title: 'Часть', direction: '' }],
      scenes: [
        {
          id: 'M01',
          original: 'строка',
          sequence: 's',
          start_frame: 0,
          end_frame_exclusive: 60,
          camera: 'к',
          action: 'а',
          continuity: '',
          references: ['mira'],
          lipsync: true,
          card: { primary_reference: 'mira' },
          state_from: null,
          state_changes: {}
        },
        {
          id: 'M02',
          original: '',
          sequence: 's',
          start_frame: 60,
          end_frame_exclusive: 120,
          camera: 'к',
          action: 'а',
          continuity: '',
          references: ['mira'],
          lipsync: false,
          card: { primary_reference: 'mira' },
          state_from: 'M01',
          state_changes: {}
        }
      ]
    });
    const pkg = join(project, 'plan/batches/M01-attempt-01');
    mkdirSync(join(pkg, 'frames'), { recursive: true });
    mkdirSync(join(pkg, 'request/inputs'), { recursive: true });
    writeFileSync(join(pkg, 'frames/K01.png'), 'png');
    writeFileSync(join(pkg, 'video-prompt.txt'), 'Промпт');
    writeFileSync(join(pkg, 'request/prompt.txt'), 'Согласованный промпт попытки');
    writeFileSync(join(pkg, 'description.md'), 'Описание');
    writeFileSync(join(pkg, 'request/original.mp4'), 'video');
    const { projectFingerprints } = await import('./shot-acceptance');
    writeJson(join(pkg, 'workflow.json'), {
      schema_version: 1,
      shot: 'M01',
      stage: 'downloaded',
      scene_sha256: projectFingerprints(project, JSON.parse(readFileSync(join(project, 'plan/scenes.json'), 'utf8'))).M01,
      mode: 'shot',
      request_dir: 'request',
      timing: { frames: 60, window_seconds: 2, request_seconds: 3 },
      keyframes: [
        { id: 'K01', role: 'first', time_seconds: 0, note: 'первый', path: 'frames/K01.png', approved: false },
        { id: 'K02', role: 'last', time_seconds: 3, path: null, approved: false }
      ],
      prompt: { path: 'video-prompt.txt', approved: true },
      pending_decision: { stage: 'downloaded', question: 'Принять?', options: ['accept', 'retry'] },
      decision: null
    });
    writeJson(join(pkg, 'request/request.json'), {
      schema_version: 1,
      provider: 'test',
      model: 'test-video-v3_0',
      parameters: { duration: 3 },
      model_selection: { preferredModel: 'test-video-v2_5', selectedModel: 'test-video-v3_0', reason: 'Предпочтительная модель не поддерживает duration=3.' },
      inputs: [{ slot: 'image_1', role: 'first', path: 'inputs/01.png' }]
    });
    writeJson(join(pkg, 'request/attempt.json'), {
      request_sha256: 'abc',
      status: 'downloaded',
      generation_id: 'job-1',
      credits_consumed: 24,
      downloads: [{ number: 1, path: 'original.mp4', bytes: 5 }]
    });
    writeJson(join(project, 'assets/shots/M02/manifest.json'), {
      accepted_edit: { video: { path: 'video.mp4' } },
      generation: { original: { path: 'original.mp4' } }
    });
    writeFileSync(join(project, 'assets/shots/M02/video.mp4'), 'монтаж');
    writeFileSync(join(project, 'assets/shots/M02/original.mp4'), 'оригинал');
    stampAcceptedShots(project, ['M02']);
    const view = viewProduction(project);
    expect(view.shots.map((s) => [s.id, s.state])).toEqual([
      ['M01', 'progress'],
      ['M02', 'completed']
    ]);
    const m01 = view.shots[0];
    expect(m01.stageLabel).toBe('ждёт вашего решения: Принять?');
    const p = m01.packages[0];
    expect(p.stage).toBe('downloaded');
    expect(p.keyframes.map((k) => [k.id, !!k.imagePath, k.approved])).toEqual([
      ['K01', true, false],
      ['K02', false, false]
    ]);
    expect(p.description).toBe('Описание');
    expect(p.prompt?.approved).toBe(true);
    expect(p.request).toMatchObject({
      sha256: 'abc',
      model: 'test-video-v3_0',
      promptText: 'Согласованный промпт попытки',
      modelSelection: { preferredModel: 'test-video-v2_5', selectedModel: 'test-video-v3_0', reason: 'Предпочтительная модель не поддерживает duration=3.' },
      attemptStatus: 'downloaded',
      generationId: 'job-1',
      creditsConsumed: 24
    });
    expect(p.request?.downloads).toEqual([join(pkg, 'request/original.mp4')]);
    expect(p.pendingDecision?.options).toEqual(['accept', 'retry']);
    expect(view.shots[1].asset?.video).toBe(join(project, 'assets/shots/M02/video.mp4'));
    expect(view.shots[1].stageLabel).toBe('принят, монтажное видео сохранено');
    expect(view.problems).toEqual([]);
  });

  it('сохраняет приёмку при потере монтажного файла и показывает его отсутствие вместо готового комплекта', async () => {
    const { viewProduction } = await import('./production');
    writeJson(join(work, 'plan/scenes.json'), {
      fps: 30,
      sequences: [{ id: 's', title: 'Часть' }],
      scenes: [{ id: 'M01', sequence: 's', start_frame: 0, end_frame_exclusive: 60 }]
    });
    writeJson(join(work, 'plan/project.json'), { name: 'Проверка приёмки' });
    const asset = join(work, 'assets/shots/M01');
    writeJson(join(asset, 'manifest.json'), {
      accepted_edit: { video: { path: 'video.mp4' } },
      generation: { original: { path: 'original.mp4' } }
    });
    writeFileSync(join(asset, 'original.mp4'), 'сохранённый платный оригинал');
    writeFileSync(join(asset, 'video.mp4'), 'принятый монтаж');
    stampAcceptedShots(work, ['M01']);
    expect(viewProduction(work).shots[0].asset?.video).toBe(join(asset, 'video.mp4'));

    // Потеря производного файла не должна стирать приёмку или скрывать сохранённый оригинал.
    rmSync(join(asset, 'video.mp4'));
    const shot = viewProduction(work).shots[0];
    expect(shot.state).toBe('completed');
    expect(shot.stageLabel).toBe('принят, файл монтажного видео отсутствует');
    expect(shot.asset).toEqual({ dir: asset, video: null, original: join(asset, 'original.mp4') });

    // Папка с прежним именем файла также не является готовым монтажом.
    mkdirSync(join(asset, 'video.mp4'));
    expect(viewProduction(work).shots[0].asset?.video).toBeNull();
    rmSync(join(asset, 'video.mp4'), { recursive: true });
    writeFileSync(join(asset, 'video.mp4'), 'восстановленный монтаж');
    expect(viewProduction(work).shots[0].stageLabel).toBe('принят, монтажное видео сохранено');
  });
});

describe('панель проверок', () => {
  it('собирает шаги проверок и путь пробы, общее задание не останавливается на первой ошибке', async () => {
    const { CHECKS, Checks, checkStep, reviewOutput } = await import('./checks');
    expect(CHECKS.map((c) => c.id)).toEqual(['lint', 'views', 'assets', 'workspace', 'status']);
    expect(checkStep('lint', { strict: true })).toMatchObject({ tool: 'lint_registry', args: ['--strict'] });
    expect(checkStep('views')).toMatchObject({ tool: 'update_scene_views', args: ['--check'] });
    expect(checkStep('status', { next: true }).args).toEqual(['--next']);
    expect(checkStep('assets').args).toEqual([]);
    // Общий запуск использует те же флажки, что и кнопки отдельных проверок.
    const { Jobs } = await import('./jobs');
    const jobs = new Jobs(null, join(work, 'jobs'));
    let captured: Parameters<typeof jobs.start>[3] = [];
    jobs.start = (_kind, _title, _project, steps) => {
      captured = steps;
      return {} as JobInfo;
    };
    new Checks(jobs).runAll(work, { strict: true, next: true });
    expect(captured.find((step) => step.tool === 'lint_registry')?.args).toEqual(['--strict']);
    expect(captured.find((step) => step.tool === 'shot_status')?.args).toEqual(['--next']);
    expect(captured.every((step) => step.stop === false)).toBe(true);
    expect(reviewOutput('/p', ['M01', 'M02'], 'x')).toBe(join('/p', 'plan', 'batches', 'review-M01-M02-x', 'review.mp4'));
    expect(reviewOutput('/p', ['M01', 'M02', 'M03', 'M04'], 'x')).toContain('review-M01-M04-x');
  });

  it('задание выполняет все шаги при stop: false и помечает неудачу, а при stop по умолчанию останавливается', async () => {
    const { Jobs } = await import('./jobs');
    const toolsRoot = join(work, 'complex');
    for (const [name, code] of [
      ['ok_tool', 0],
      ['bad_tool', 2]
    ] as const) {
      mkdirSync(join(toolsRoot, 'tools', name), { recursive: true });
      writeFileSync(join(toolsRoot, 'tools', name, `${name}.py`), `import sys\nprint('${name}', sys.argv[1:])\nsys.exit(${code})\n`);
    }
    const launcher = new PythonLauncher({ toolsRoot });
    // Тестовые инструменты лежат отдельно, интерпретатор берём из того же комплекта, что приложение.
    launcher.runtime = () => resolvePython({ toolsRoot: REPO });
    const jobs = new Jobs(toolsRoot, join(work, 'local'), launcher);
    const wait = async (id: string): Promise<JobInfo | null> => {
      for (let i = 0; i < 100 && jobs.get(id)?.status === 'running'; i++) await new Promise((r) => setTimeout(r, 50));
      return jobs.get(id);
    };
    const all = await wait(
      jobs.start('check', 'все', work, [
        { tool: 'bad_tool', args: ['--x'], stop: false },
        { tool: 'ok_tool', args: [], stop: false }
      ]).id
    );
    expect(all?.status).toBe('failed');
    expect(all?.code).toBe(2);
    expect(all?.steps.map((s) => [s.status, s.code])).toEqual([
      ['failed', 2],
      ['done', 0]
    ]);
    expect(all?.log).toContain("ok_tool ['--project'");
    const stopped = await wait(
      jobs.start('check', 'стоп', work, [
        { tool: 'bad_tool', args: [] },
        { tool: 'ok_tool', args: [] }
      ]).id
    );
    expect(stopped?.steps.map((s) => s.status)).toEqual(['failed', 'pending']);
    expect(stopped?.log).toContain('задание остановлено');
    const optional = await wait(
      jobs.start('check', 'необязательный', work, [
        { tool: 'bad_tool', args: [], required: false },
        { tool: 'ok_tool', args: [] }
      ]).id
    );
    expect(optional?.status).toBe('done');
  });

  it('читает и записывает настройки проекта, сохраняя прочие поля, и отвергает неверные', async () => {
    const { readProjectSettings, validateProjectSettings, writeProjectSettings, listReviews } = await import('./checks');
    const project = join(work, 'clip');
    writeJson(join(project, 'plan/project.json'), { schema_version: 1, name: 'Клип', animatic_video: 'a.mp4', extra: { keep: true } });
    const settings = readProjectSettings(project);
    expect(settings).toEqual({ name: 'Клип', animaticVideo: 'a.mp4', generation: null });
    expect(validateProjectSettings(settings)).toEqual([]);
    expect(() => writeProjectSettings(project, { ...settings, animaticVideo: 'dir/a.mp4' })).toThrow(/MP4/);
    // Широкий формат проходит тот же контракт сохранения и чтения Python-инструментами.
    const generation = {
      video: {
        provider: 'future-video',
        resolution: '1080p',
        aspect_ratio: '21:9',
        watermark: false,
        duration_rule: 'exact_window' as const,
        options: { backend: { keep: true } }
      },
      image: { provider: 'future-image', outputs: 2, model: 'image-v1', options: { quality: 'high' } }
    };
    expect(validateProjectSettings({ ...settings, generation: { ...generation, video: { ...generation.video, aspect_ratio: '16x9' } } })).toEqual([
      'generation.video: пропорции записываются как 16:9 или auto.'
    ]);
    const written = writeProjectSettings(project, { name: ' Новый ', animaticVideo: 'clip-v2.mp4', generation });
    expect(written).toEqual({ name: 'Новый', animaticVideo: 'clip-v2.mp4', generation });
    const raw = JSON.parse(readFileSync(join(project, 'plan/project.json'), 'utf-8'));
    expect(raw.extra).toEqual({ keep: true });
    expect(raw.generation.video.duration_rule).toBe('exact_window');
    // Инструменты комплекса принимают записанный блок.
    const python = spawnSync(
      resolvePython({ toolsRoot: REPO }).command,
      [
        '-B',
        '-c',
        `import json,sys; sys.path.insert(0, ${JSON.stringify(REPO)}); from tools.scene_registry.scene_registry import generation_settings, load_project; d=load_project(${JSON.stringify(project)}); print(json.dumps({k:generation_settings(d,k) for k in ('video','image')}))`
      ],
      { encoding: 'utf-8' }
    );
    expect(python.status, python.stderr).toBe(0);
    expect(JSON.parse(python.stdout)).toEqual(generation);
    // Список проб: только папки с MP4 и JSON рецепта build_review.
    expect(listReviews(project)).toEqual([]);
    const review = join(project, 'plan/batches/review-M01-M02-x');
    mkdirSync(review, { recursive: true });
    writeFileSync(join(review, 'review.mp4'), 'mp4');
    writeJson(join(review, 'review.json'), { shots: [{ id: 'M01' }, { id: 'M02' }], total_frames: 90, video_sha256: sha256Text('mp4') });
    writeJson(join(project, 'plan/batches/other/bundle.json'), { shots: [] });
    const reviews = listReviews(project);
    expect(reviews.map((r) => [r.shots, r.totalFrames, r.video])).toEqual([[['M01', 'M02'], 90, join(review, 'review.mp4')]]);
  });

  it('читает отдельные блоки медиа и сохраняет расширения при записи', async () => {
    const { readProjectSettings, validateProjectSettings, writeProjectSettings } = await import('./checks');
    const project = join(work, 'settings-compat');
    const path = join(project, 'plan/project.json');
    const video = {
      provider: 'future-video',
      resolution: '1080p',
      aspect_ratio: '16:9',
      watermark: false,
      duration_rule: 'exact_window' as const,
      custom: { keep: true },
      options: { backend: { keep: 3 }, quality: 'high' }
    };
    const base = { schema_version: 1, name: 'Клип', animatic_video: 'clip.mp4', extra: { keep: true } };
    const image = { provider: 'future-image', backend: { keep: true }, options: { backend: { keep: 'image' } } };
    writeJson(path, { ...base, generation: { video: false, image, extension: { keep: true } } });
    expect(readProjectSettings(project).generation).toMatchObject({ video: null, image });
    writeProjectSettings(project, { ...readProjectSettings(project), name: 'Новое имя' });
    expect(JSON.parse(readFileSync(path, 'utf8')).generation.video).toBe(false);
    writeJson(path, { ...base, generation: { video, image, extension: { keep: true } } });
    const saved = writeProjectSettings(project, {
      name: 'Клип',
      animaticVideo: 'clip.mp4',
      generation: {
        video: {
          provider: video.provider,
          resolution: '720p',
          aspect_ratio: '16:9',
          watermark: false,
          duration_rule: 'exact_window',
          options: { quality: 'low' }
        },
        image: { provider: image.provider }
      }
    });
    expect(saved.generation).toEqual({
      video: { ...video, resolution: '720p', options: { ...video.options, quality: 'low' } },
      image,
      extension: { keep: true }
    });
    expect(JSON.parse(readFileSync(path, 'utf8')).extra).toEqual(base.extra);
    expect(readdirSync(join(project, 'plan')).filter((name) => name.endsWith('.tmp'))).toEqual([]);
    for (const generation of [{ video, image: null }, { image }, { video: null, image: null }]) {
      writeJson(path, { ...base, generation });
      expect(readProjectSettings(project).generation).toEqual({ video: 'video' in generation ? generation.video : null, image: generation.image });
    }
    // Динамический auto проходит сохранение и чтение обоими контрактами до проверки модели в prepare.
    const automatic = { video: { ...video, aspect_ratio: 'auto' }, image: { provider: 'test', model: 'live-model', aspect_ratio: 'auto' } };
    writeProjectSettings(project, { name: 'Клип', animaticVideo: 'clip.mp4', generation: automatic });
    expect(readProjectSettings(project).generation).toEqual(automatic);
    const python = spawnSync(
      resolvePython({ toolsRoot: REPO }).command,
      [
        '-B',
        '-c',
        `import json,sys;sys.path.insert(0,${JSON.stringify(REPO)});from tools.scene_registry.scene_registry import load_project,generation_settings;p=load_project(${JSON.stringify(project)});print(json.dumps({k:generation_settings(p,k)['aspect_ratio'] for k in ('video','image')}))`
      ],
      { encoding: 'utf8' }
    );
    expect(python.status, python.stderr).toBe(0);
    expect(JSON.parse(python.stdout)).toEqual({ video: 'auto', image: 'auto' });
    for (const aspect_ratio of ['wide', '', ' ', null, 3, true, [], {}]) {
      writeJson(path, { ...base, generation: { ...automatic, video: { ...automatic.video, aspect_ratio } } });
      expect(validateProjectSettings(readProjectSettings(project)).length).toBeGreaterThan(0);
    }
  });

  it('создаёт проект без выбранных медиапровайдеров и не подтверждает старые настройки при сохранении имени', async () => {
    const { readProjectSettings, validateProjectSettings, writeProjectSettings } = await import('./checks');
    const template = JSON.parse(readFileSync(join(REPO, 'templates/project/plan/project.json'), 'utf8'));
    expect(template.generation).toEqual({ video: null, image: null });
    const project = join(work, 'explicit-provider-selection');
    const path = join(project, 'plan/project.json');
    const base = { schema_version: 1, name: 'Клип', animatic_video: 'clip.mp4' };
    for (const provider_selected of [undefined, false, true]) {
      const image = { provider: 'codex', model: 'saved-model', options: { custom: true }, ...(provider_selected === undefined ? {} : { provider_selected }) };
      writeJson(path, { ...base, generation: { video: null, image } });
      const settings = readProjectSettings(project);
      expect(validateProjectSettings(settings)).toEqual([]);
      writeProjectSettings(project, { ...settings, name: 'Новое имя' });
      expect(JSON.parse(readFileSync(path, 'utf8')).generation.image).toEqual(image);
    }
    for (const provider_selected of ['true', 1, null, {}, []]) {
      const settings = { name: 'Клип', animaticVideo: 'clip.mp4', generation: { video: null, image: { provider: 'codex', provider_selected } } };
      expect(validateProjectSettings(settings as unknown as ProjectSettings)).toContain(
        'generation.image: provider_selected должен быть логическим значением.'
      );
    }
  });

  it('удаляет необязательные настройки по undefined из IPC, сохраняя расширения и обязательные поля', async () => {
    const { readProjectSettings, validateProjectSettings, writeProjectSettings } = await import('./checks');
    const project = join(work, 'settings-clear-optional');
    const path = join(project, 'plan/project.json');
    const video = {
      provider: 'test',
      resolution: '1080p',
      aspect_ratio: '16:9',
      watermark: false,
      duration_rule: 'exact_window' as const,
      model: 'video-model',
      options: { quality: 'high' },
      extension: { keep: 'video' }
    };
    const image = {
      provider: 'codex',
      model: 'image-model',
      resolution: '1k',
      aspect_ratio: '16:9',
      outputs: 2,
      watermark: false,
      options: { quality: 'high' },
      extension: { keep: 'image' }
    };
    writeJson(path, { schema_version: 1, name: 'Клип', animatic_video: 'clip.mp4', generation: { video, image } });
    const settings = readProjectSettings(project);
    expect(settings.generation?.image).toEqual(image);
    // structured clone сохраняет эти ключи: их нельзя пропускать перед merge как отсутствующие.
    const saved = writeProjectSettings(project, {
      ...settings,
      generation: {
        video: { ...video, model: undefined, options: undefined },
        image: {
          provider: 'codex',
          model: undefined,
          resolution: undefined,
          aspect_ratio: undefined,
          outputs: undefined,
          watermark: undefined,
          options: undefined
        }
      }
    });
    const raw = JSON.parse(readFileSync(path, 'utf8'));
    expect(raw.generation.image).toEqual({ provider: 'codex', extension: { keep: 'image' } });
    const { model: _model, options: _options, ...requiredVideo } = video;
    expect(raw.generation.video).toEqual(requiredVideo);
    expect(saved.generation).toEqual(raw.generation);
    for (const field of ['provider', 'resolution', 'aspect_ratio', 'duration_rule', 'watermark']) {
      expect(validateProjectSettings({ ...settings, generation: { video: { ...video, [field]: undefined }, image: null } }).length).toBeGreaterThan(0);
    }
    for (const [field, value] of [
      ['model', null],
      ['model', ''],
      ['model', false],
      ['resolution', null],
      ['resolution', ''],
      ['resolution', 0],
      ['aspect_ratio', null],
      ['aspect_ratio', ''],
      ['aspect_ratio', 'wide'],
      ['outputs', null],
      ['outputs', 0],
      ['outputs', Number.NaN],
      ['outputs', false],
      ['watermark', null],
      ['watermark', 'false'],
      ['options', null],
      ['options', []]
    ]) {
      expect(
        validateProjectSettings({ ...settings, generation: { video: null, image: { provider: 'codex', [field as string]: value } } }).length
      ).toBeGreaterThan(0);
    }
  });

  it('одинаково с Python диагностирует несовместимые типы параметров изображений', async () => {
    const { readProjectSettings, validateProjectSettings } = await import('./checks');
    const project = join(work, 'settings-invalid');
    for (const image of [
      { provider: 'codex', outputs: 0 },
      { provider: 'codex', outputs: true },
      { provider: 'codex', options: [] },
      { provider: 'codex', model: 1 },
      { provider: 'codex', watermark: 'no' },
      { provider: 'codex', aspect_ratio: 'wide' }
    ]) {
      writeJson(join(project, 'plan/project.json'), { schema_version: 1, name: 'Клип', animatic_video: 'clip.mp4', generation: { video: null, image } });
      expect(validateProjectSettings(readProjectSettings(project)).length).toBeGreaterThan(0);
      const python = spawnSync(
        resolvePython({ toolsRoot: REPO }).command,
        [
          '-B',
          '-c',
          `import json,sys; sys.path.insert(0, ${JSON.stringify(REPO)}); from tools.scene_registry.scene_registry import validate_project; validate_project(json.load(open(${JSON.stringify(join(project, 'plan/project.json'))})))`
        ],
        { encoding: 'utf8' }
      );
      expect(python.status).not.toBe(0);
    }
  });
});

describe('аниматик', () => {
  it('читает сборку, свежесть по реестру и принятие; принятие пишет хеш, устаревшая сборка не принимается', async () => {
    const { setAnimaticStatus, viewAnimatic } = await import('./animatic');
    const project = join(work, 'clip');
    const scenes = { schema_version: 1, scenes: [{ id: 'M01' }, { id: 'M02' }] };
    writeJson(join(project, 'plan/project.json'), { schema_version: 1, name: 'Клип', animatic_video: 'clip.mp4' });
    writeJson(join(project, 'plan/scenes.json'), scenes);
    writeJson(join(project, 'plan/production-status.json'), {
      schema_version: 1,
      current_animatic: null,
      current_animatic_status: 'none',
      extra: 'keep'
    });
    let view = viewAnimatic(project);
    expect(view.built).toBeNull();
    expect(view.approval).toEqual({ status: 'none', approvedSha256: null, current: false });
    expect(() => setAnimaticStatus(project, 'approved')).toThrow(/сначала соберите/);
    const digest = sha256Text(readFileSync(join(project, 'plan/scenes.json'), 'utf-8'));
    const latest = join(project, 'plan/animatic/latest');
    mkdirSync(join(project, 'plan/animatic/cards'), { recursive: true });
    writeFileSync(join(project, 'plan/animatic/cards/M02.png'), 'png');
    writeJson(join(project, 'plan/animatic/cards/manifest.json'), { registry_sha256: digest, cards: {} });
    mkdirSync(join(project, 'source'), { recursive: true });
    writeFileSync(join(project, 'source/track.mp3'), 'track');
    writeJson(join(project, 'assets/shots/M01/manifest.json'), {
      shot: 'M01',
      accepted_edit: { fps: 30, frames: 60, video: { path: 'video.mp4', sha256: sha256Text('video') } }
    });
    writeFileSync(join(project, 'assets/shots/M01/video.mp4'), 'video');
    writeJson(join(latest, 'manifest.json'), {
      schema_version: 1,
      video_file: 'clip.mp4',
      video_sha256: sha256Text('mp4'),
      project_inputs: { name: JSON.parse(readFileSync(join(project, 'plan/project.json'), 'utf8')).name, animatic_video: 'clip.mp4' },
      source_hashes: {
        'source/track.mp3': sha256Text('track'),
        'assets/shots/M01/video.mp4': sha256Text('video'),
        'plan/animatic/cards/M02.png': sha256Text('png')
      },
      video_duration: 4,
      total_frames: 120,
      scene_registry_sha256: digest,
      shots: [
        { id: 'M01', title: 'Первый', start: '0', end: '2', frames: 60, media: 'video', path: 'assets/shots/M01/video.mp4', sequence_title: 'Часть' },
        { id: 'M02', title: 'Второй', start: '2', end: '4', frames: 60, media: 'card', path: 'plan/animatic/cards/M02.png' }
      ]
    });
    view = viewAnimatic(project);
    expect(view.built?.videoPath).toBeNull();
    expect(view.problems[0]).toContain('MP4 сборки не найден');
    writeFileSync(join(latest, 'clip.mp4'), 'mp4');
    view = viewAnimatic(project);
    expect(view.built).toMatchObject({ videoPath: join(latest, 'clip.mp4'), fresh: true, counts: { video: 1, cards: 1, keyframes: 0 }, duration: 4 });
    expect(view.cardsFresh).toBe(true);
    expect(view.shots.map((s) => [s.id, s.media, s.cardPath])).toEqual([
      ['M01', 'video', null],
      ['M02', 'card', join(project, 'plan/animatic/cards/M02.png')]
    ]);
    expect(view.problems).toEqual([]);
    view = setAnimaticStatus(project, 'approved');
    expect(view.approval).toEqual({ status: 'approved', approvedSha256: sha256Text('mp4'), current: true });
    const status = JSON.parse(readFileSync(join(project, 'plan/production-status.json'), 'utf-8'));
    expect(status.approved_animatic).toEqual({
      manifest: 'plan/animatic/latest/manifest.json',
      video: 'plan/animatic/latest/clip.mp4',
      video_sha256: sha256Text('mp4')
    });
    expect(status.extra).toBe('keep');
    expect(computeStatus(project).checks.animaticApproved).toBe(true);
    // Реестр изменился: сборка устарела, принятие не сходится и новое принятие запрещено.
    writeJson(join(project, 'plan/scenes.json'), { ...scenes, scenes: [{ id: 'M01' }] });
    view = viewAnimatic(project);
    expect(view.built?.fresh).toBe(false);
    expect(view.approval.current).toBe(false);
    expect(computeStatus(project).checks.animaticApproved).toBe(false);
    expect(view.problems).toEqual(['Реестр сцен изменился после сборки: аниматик устарел, нужна пересборка.']);
    expect(() => setAnimaticStatus(project, 'approved')).toThrow(/устаревшему/);
    view = setAnimaticStatus(project, 'review');
    expect(view.approval).toEqual({ status: 'review', approvedSha256: null, current: false });
    expect(JSON.parse(readFileSync(join(project, 'plan/production-status.json'), 'utf-8')).approved_animatic).toBeUndefined();
  });
});

describe('дашборд сцен', () => {
  it('собирает по плану комплект, опоры пакета, промпт, карточку и состояние до и после', async () => {
    const { viewDashboard } = await import('./dashboard');
    const project = join(work, 'clip');
    writeJson(join(project, 'plan/project.json'), { schema_version: 1, name: 'Клип', animatic_video: 'a.mp4' });
    writeJson(join(project, 'plan/cast.json'), {
      schema_version: 1,
      entities: [
        {
          id: 'mira',
          kind: 'character',
          name: 'Мира',
          short_name: 'Мира',
          role: '',
          appearance: '',
          images: ['heroes/mira.jpg'],
          initial_state: { coat_state: 'сухая' }
        }
      ],
      properties: {}
    });
    mkdirSync(join(project, 'source/heroes'), { recursive: true });
    writeFileSync(join(project, 'source/heroes/mira.jpg'), 'jpg');
    writeJson(join(project, 'plan/scenes.json'), {
      schema_version: 1,
      fps: 30,
      audio: { path: 'source/track.mp3', end_seconds: '4' },
      references: { mira: { name: 'Мира', path: 'source/heroes/mira.jpg', short_name: 'Мира' } },
      visual_direction: 'x',
      sequences: [{ id: 's', title: 'Часть', direction: '' }],
      scenes: [
        {
          id: 'M01',
          original: 'строка',
          sequence: 's',
          start_frame: 0,
          end_frame_exclusive: 60,
          camera: 'к',
          action: 'а',
          continuity: '',
          references: ['mira'],
          lipsync: true,
          card: { primary_reference: 'mira' },
          state_from: null,
          state_changes: { after: { mira: { coat_state: 'мокрая' } } }
        },
        {
          id: 'M02',
          original: '',
          sequence: 's',
          start_frame: 60,
          end_frame_exclusive: 120,
          camera: 'к',
          action: 'а',
          continuity: '',
          references: ['mira'],
          lipsync: false,
          card: { primary_reference: 'mira' },
          state_from: 'M01',
          state_changes: {}
        }
      ]
    });
    // M01: принятый комплект с оригиналом, монтажом, промптом, снимком запроса и входами (один через source).
    const asset = join(project, 'assets/shots/M01');
    mkdirSync(asset, { recursive: true });
    for (const name of ['original.mp4', 'video.mp4', 'first-frame.png']) writeFileSync(join(asset, name), name);
    writeFileSync(join(asset, 'generation-prompt.txt'), 'Промпт принятой');
    writeJson(join(asset, 'generation-request.json'), { schema_version: 1, provider: 'Test', model: 'test-video-v3_0', parameters: { duration: 5 } });
    writeJson(join(asset, 'manifest.json'), {
      schema_version: 1,
      shot: 'M01',
      kind: 'generated_video',
      generation: {
        original: { path: 'original.mp4' },
        original_media: { width: 1920, height: 1088, r_frame_rate: '24/1', duration: '5.04', nb_frames: '121' },
        prompt: { path: 'generation-prompt.txt' },
        request: { path: 'generation-request.json' },
        inputs: [
          { path: 'first-frame.png', role: 'первый кадр' },
          { root: 'source', path: 'heroes/mira.jpg', role: 'референс' },
          { path: 'speech.wav', role: 'звук' }
        ],
        lipsync: true
      },
      accepted_edit: {
        video: { path: 'video.mp4' },
        frames: 60,
        duration_seconds: 2,
        source_interval_seconds: [1, 3],
        speed: { factor: 1, ratio: '1' },
        hold_first_seconds: 0,
        hold_last_seconds: 0.5,
        processing_note: 'обрезка'
      }
    });
    stampAcceptedShots(project, ['M01']);
    const { projectFingerprints } = await import('./shot-acceptance');
    // M02: пакет с кандидатом опоры и промптом, карточка аниматика.
    const pkg = join(project, 'plan/batches/M02-attempt-01');
    mkdirSync(join(pkg, 'frames'), { recursive: true });
    writeFileSync(join(pkg, 'frames/K01.png'), 'png');
    writeFileSync(join(pkg, 'video-prompt.txt'), 'Промпт пакета');
    writeJson(join(pkg, 'workflow.json'), {
      schema_version: 1,
      shot: 'M02',
      stage: 'keyframes_review',
      scene_sha256: projectFingerprints(project, JSON.parse(readFileSync(join(project, 'plan/scenes.json'), 'utf8'))).M02,
      keyframes: [{ id: 'K01', role: 'first', time_seconds: 0, path: 'frames/K01.png', approved: false }],
      prompt: { path: 'video-prompt.txt', approved: false }
    });
    mkdirSync(join(project, 'plan/animatic/cards'), { recursive: true });
    writeFileSync(join(project, 'plan/animatic/cards/M02.png'), 'png');

    const view = viewDashboard(project, REPO);
    expect(view.summary).toEqual({ total: 2, completed: 1, stale: 0, progress: 1, planned: 0, duration: 4, completedSeconds: 2 });
    const [m1, m2] = view.shots;
    expect(m1.state).toBe('completed');
    expect(m1.asset?.video).toBe(join(asset, 'video.mp4'));
    expect(m1.asset?.original).toBe(join(asset, 'original.mp4'));
    expect(m1.asset?.originalMedia).toBe('1920×1088, 24/1 кадр/с, 121 кадров, 5.04 с');
    expect(m1.asset?.edit).toMatchObject({ frames: 60, duration: 2, sourceInterval: [1, 3], speed: '1', holdLast: 0.5, note: 'обрезка' });
    expect(m1.asset?.prompt).toBe('Промпт принятой');
    expect(m1.asset?.request).toEqual({ provider: 'Test', model: 'test-video-v3_0', parameters: { duration: 5 } });
    expect(m1.asset?.inputs).toEqual([
      { path: join(asset, 'first-frame.png'), role: 'первый кадр' },
      { path: join(project, 'source/heroes/mira.jpg'), role: 'референс' }
    ]);
    expect(m1.keyframes.map((k) => [k.label, k.approved])).toEqual([
      ['первый кадр', true],
      ['референс', true]
    ]);
    expect(m1.thumbnail).toBe(join(asset, 'first-frame.png'));
    expect(m1.references).toEqual([{ id: 'mira', name: 'Мира', imagePath: join(project, 'source/heroes/mira.jpg') }]);
    expect(m1.before?.state).toEqual({ mira: { coat_state: 'сухая' } });
    expect(m1.after?.state).toEqual({ mira: { coat_state: 'мокрая' } });
    expect(m1.after?.lines).toEqual(['Мира: coat state: мокрая.']);
    expect(m2.state).toBe('progress');
    expect(m2.asset).toBeNull();
    expect(m2.package?.prompt).toBe('Промпт пакета');
    expect(m2.keyframes).toEqual([{ imagePath: join(pkg, 'frames/K01.png'), label: 'K01 · first', approved: false }]);
    expect(m2.cardPath).toBe(join(project, 'plan/animatic/cards/M02.png'));
    expect(m2.thumbnail).toBe(join(pkg, 'frames/K01.png'));
    expect(m2.before?.state).toEqual({ mira: { coat_state: 'мокрая' } });
    expect(view.problems).toEqual([]);
  });
});

describe('проект-образец tools/testdata/sample-project', () => {
  it('читает метаданные без MP4: статус, исходники, тайминги, настройки, дашборд и несвежий аниматик', async () => {
    const { viewDashboard } = await import('./dashboard');
    const { viewAnimatic } = await import('./animatic');
    const { readProjectSettings, validateProjectSettings } = await import('./checks');
    const { viewSources } = await import('./sources');
    const { viewTiming } = await import('./timing');
    const sample = join(work, 'sample-project');
    cpSync(join(REPO, 'tools/testdata/sample-project'), sample, { recursive: true });
    // MP4 сборки не хранится в Git: исключаем локальный результат генерации и проверяем состояние чистого checkout.
    const latest = join(sample, 'plan/animatic/latest');
    for (const name of readdirSync(latest)) if (name.endsWith('.mp4')) rmSync(join(latest, name));
    expect(existsSync(join(latest, 'sample-animatic.mp4'))).toBe(false);
    const status = computeStatus(sample);
    expect(status.problems).toEqual([]);
    expect(status.state).toBe('in_production');
    expect(status.checks).toMatchObject({
      sources: true,
      timing: true,
      cast: true,
      treatment: true,
      scenes: true,
      shotsTotal: 5,
      shotsDone: 2,
      animaticBuilt: true,
      animaticFresh: false,
      animaticApproved: false
    });
    expect(viewSources(sample).problems).toEqual([]);
    expect(viewTiming(sample).problems).toEqual([]);
    expect(validateProjectSettings(readProjectSettings(sample))).toEqual([]);
    const dashboard = viewDashboard(sample, REPO);
    expect(dashboard.problems).toEqual([]);
    expect(dashboard.summary).toMatchObject({ total: 5, completed: 2, progress: 1, planned: 2, duration: 30 });
    expect(dashboard.shots.map((s) => s.state)).toEqual(['completed', 'completed', 'progress', 'planned', 'planned']);
    expect(dashboard.shots[0].asset?.inputs.map((i) => i.role)).toEqual(['Первый кадр']);
    expect(dashboard.shots[2].package?.prompt).toContain('фонарики');
    expect(dashboard.shots[4].before?.state).toEqual(dashboard.shots[1].before?.state);
    const animatic = viewAnimatic(sample);
    expect(animatic.shots.map((s) => s.media)).toEqual(['video', 'video', 'card', 'card', 'card']);
    expect(animatic.built).toMatchObject({ videoPath: null, fresh: false });
    expect(animatic.problems).toContain('MP4 сборки не найден: sample-animatic.mp4. Соберите аниматик заново.');
    expect(animatic.approval.status).toBe('review');
  });
});
