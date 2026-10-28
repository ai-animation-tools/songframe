/** Перенос и состояние проверяются на временных проектах, без открытия UI и изменения клипов пользователя. */
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeLocalStorage } from './local-storage';
import { writeAtomicText } from './local-files';
import { resolvePaths } from './paths';
import { Projects } from './projects';
import { PythonLauncher } from './python-launcher';
import { SettingsStore } from './settings';
import { LocalState } from './state';

const REPO = resolve(__dirname, '../..');
let work: string;
function treePermissions(path: string, writable: boolean): void {
  chmodSync(path, writable ? 0o700 : 0o500);
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) treePermissions(child, writable);
    else if (entry.isFile()) chmodSync(child, writable ? 0o600 : 0o400);
  }
}
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'Перенос клипа '));
});
afterEach(() => {
  vi.restoreAllMocks();
  treePermissions(work, true);
  rmSync(work, { recursive: true, force: true });
});

function json(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

describe('Постоянное состояние', () => {
  it('создаёт каталог состояния без переноса прежних данных', () => {
    const previous = join(work, '.local');
    const local = join(work, 'userData');
    json(join(previous, 'settings.json'), { toolsRootOverride: '/старый checkout' });
    initializeLocalStorage(local);
    expect(existsSync(local)).toBe(true);
    expect(existsSync(join(local, 'settings.json'))).toBe(false);
    expect(existsSync(join(local, 'state-migration.json'))).toBe(false);
  });
  it('не сбрасывает повреждённые файлы и убирает временный файл после неудачной замены', () => {
    const local = join(work, 'данные');
    const state = new LocalState(local);
    json(state.historyFile, { schema_version: 1, projects: [] });
    writeFileSync(state.historyFile, '{');
    expect(() => state.touchHistory('/clip', 'Клип')).toThrow(/Файл сохранён/);
    expect(readFileSync(state.historyFile, 'utf8')).toBe('{');
    json(join(local, 'settings.json'), []);
    expect(() => new SettingsStore(local).write({})).toThrow(/Неверный формат/);
    const directory = join(work, 'нельзя заменить папку');
    mkdirSync(directory);
    expect(() => writeAtomicText(directory, 'новые данные')).toThrow(/Не удалось сохранить/);
    expect(readdirSync(work).some((name) => name.endsWith('.tmp'))).toBe(false);
  });
  it.skipIf(process.getuid?.() === 0)('сообщает о недоступном каталоге, сохраняя прежний файл', () => {
    const local = join(work, 'read-only');
    const state = new LocalState(local);
    state.writeCurrent('/old');
    chmodSync(local, 0o500);
    try {
      expect(() => state.writeCurrent('/new')).toThrow(/доступ на запись/);
    } finally {
      chmodSync(local, 0o700);
    }
    expect(state.readCurrent()).toBe('/old');
  });
  it('общие настройки и история переживают создание сервисов с другим каталогом ресурсов', () => {
    const options = { appPath: '/несуществующий checkout', execPath: '/app', cwd: '/', userData: join(work, 'user'), packaged: true };
    for (const location of ['Старая поставка', 'Перенесённая поставка']) {
      const resources = join(work, location, 'resources');
      json(join(resources, 'tools/common.py'), {});
      const paths = resolvePaths({ ...options, resourcesPath: resources, override: '/прошлый checkout' });
      expect(paths.resourcesRoot).toBe(resources);
      expect(paths.runtimeRoot).toBe(join(resources, 'runtime'));
      expect(paths.localDir).toBe(options.userData);
    }
    expect(resolvePaths({ ...options, localDirOverride: join(work, 'явное состояние') }).localDir).toBe(join(work, 'явное состояние'));
    const settings = new SettingsStore(options.userData);
    settings.write({ toolsRootOverride: null });
    new LocalState(options.userData).writeCurrent('/clip');
    expect(new SettingsStore(options.userData).read()).toEqual({ toolsRootOverride: null });
    expect(new LocalState(options.userData).readCurrent()).toBe('/clip');
    const invalid = resolvePaths({ ...options, packaged: false, override: join(work, 'missing') });
    expect(invalid.toolsRoot).toBeNull();
    expect(invalid.problems[0]).toContain('Выберите её заново');
  });
});

function files(path: string): string[] {
  return readdirSync(path, { withFileTypes: true }).flatMap((entry) => {
    const child = join(path, entry.name);
    return entry.isDirectory() ? files(child) : [child];
  });
}

describe('Перенос проекта', () => {
  it('создаёт проект без путей ресурсов и служебных файлов, сохраняет данные при переносе проекта', () => {
    const resources = join(work, 'Ресурсы');
    cpSync(join(REPO, 'templates'), join(resources, 'templates'), { recursive: true });
    treePermissions(resources, false);
    const state = new LocalState(join(work, 'Состояние'));
    const project = join(work, 'Первый клип');
    new Projects(state, resources, 'linux').create({ name: 'Клип', path: project });
    for (const file of files(project).filter((path) => !path.includes('/.git/'))) {
      const text = readFileSync(file, 'utf8');
      expect(text, file).not.toContain(resources);
      expect(text, file).not.toContain(work);
    }
    for (const absent of ['AGENTS.md', '.vscode', '.songframe', '.agents', '.claude']) expect(existsSync(join(project, absent)), absent).toBe(false);
    writeFileSync(join(project, 'source/text.md'), 'Исходник не изменять');
    writeFileSync(join(project, 'README.md'), readFileSync(join(project, 'README.md'), 'utf8') + '\nМоя заметка');
    json(join(project, 'plan/scenes.json'), { schema_version: 1, scenes: [{ id: 'M01', action: 'Ручная постановка' }] });
    const scenes = readFileSync(join(project, 'plan/scenes.json'));
    const readme = readFileSync(join(project, 'README.md'), 'utf8');
    const moved = join(work, 'Перенесённый клип');
    renameSync(project, moved);
    new Projects(state, resources, 'linux').open(moved);
    expect(readFileSync(join(moved, 'source/text.md'), 'utf8')).toBe('Исходник не изменять');
    expect(readFileSync(join(moved, 'plan/scenes.json'))).toEqual(scenes);
    expect(readFileSync(join(moved, 'README.md'), 'utf8')).toBe(readme);
    expect(state.readCurrent()).toBe(moved);
  });
});

describe('Python и состояние приложения', () => {
  it('настоящий current_project без явного проекта читает состояние приложения, ресурсы не используются для записи', async () => {
    const local = join(work, 'CLI-состояние');
    initializeLocalStorage(local);
    const project = join(work, 'Клип');
    json(join(project, 'plan/project.json'), { schema_version: 1, name: 'Клип' });
    const launcher = new PythonLauncher({ toolsRoot: REPO, localDir: local });
    const set = await launcher.run(null, 'current_project', ['--json', 'set', project]);
    expect(set.code, set.stderr).toBe(0);
    expect(JSON.parse(set.stdout).path).toBe(project);
    expect(new LocalState(local).readCurrent()).toBe(project);
    const show = await launcher.run(null, 'current_project', ['--json', 'show']);
    expect(show.code, show.stderr).toBe(0);
    expect(JSON.parse(show.stdout).source).toBe('current_file');
    const settings = new SettingsStore(local);
    settings.write({ toolsRootOverride: null });
    expect(existsSync(join(local, 'settings.json'))).toBe(true);
  });
});
