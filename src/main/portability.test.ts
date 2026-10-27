/** Перенос и миграция проверяются на временных проектах, без открытия UI и изменения клипов пользователя. */
import { spawnSync } from 'node:child_process';
import { chmodSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { initializeLocalStorage } from './local-storage';
import { writeAtomicText } from './local-files';
import { resolvePaths } from './paths';
import { appCommand, migrateSchemaLinks } from './project-integration';
import { Projects } from './projects';
import { PythonLauncher } from './python-launcher';
import { SettingsStore } from './settings';
import { LocalState } from './state';
import { runToolCli } from './tool-cli';

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

describe('Проектные ссылки', () => {
  it('использует постоянный APPIMAGE вместо временного execPath и не сохраняет путь checkout', () => {
    const result = appCommand({
      packaged: true,
      appImage: '/поставки/Мой AppImage',
      execPath: '/tmp/.mount/app',
      appPath: '/несуществующий checkout',
      localDir: work
    });
    expect(result).toEqual({ command: '/поставки/Мой AppImage', args: [], localDir: work });
  });
  it('меняет только известные URL схем, сохраняя комментарии, чужую схему и завершающие запятые', () => {
    const text = `{
  // настройка владельца
  "editor.fontSize": 17,
  "json.schemas": [
    {"fileMatch": ["/plan/scenes.json"], "url": "C:\\\\старый checkout\\\\tools\\\\lint_registry\\\\schemas\\\\scenes.schema.json"}, // сохранить комментарий
    {"fileMatch": ["/my.json"], "url": "/custom/tools/lint_registry/schemas/scenes.schema.json"},
    {"fileMatch": ["/plan/cast.json"], "url": "/custom/cast.json"},
  ],
}`;
    const next = migrateSchemaLinks(text);
    expect(next).toContain('"url": "./.songframe/tools/lint_registry/schemas/scenes.schema.json"');
    expect(next).toContain('// сохранить комментарий');
    expect(next).toContain('/custom/tools/lint_registry/schemas/scenes.schema.json');
    expect(next).toContain('/custom/cast.json');
    expect(next).toContain('"editor.fontSize": 17');
    expect(migrateSchemaLinks(next)).toBe(next);
    expect(() => migrateSchemaLinks('{')).toThrow(/Файл не изменён/);
  });
  it('мигрирует старый управляемый блок и JSONC, не присваивая себе чужой проект', () => {
    const project = join(work, 'Старый проект');
    json(join(project, 'plan/project.json'), { schema_version: 1, name: 'Старый клип' });
    const before = 'Моё начало\n<!-- songframe:begin -->\n/tmp/.mount_old/tools\n<!-- songframe:end -->\nМоя команда и правило после блока\n';
    writeFileSync(join(project, 'AGENTS.md'), before);
    const settings = join(project, '.vscode/settings.json');
    mkdirSync(dirname(settings));
    const config =
      '{ // мой комментарий\n "editor.tabSize": 3, "json.schemas": [{"fileMatch":["/plan/scenes.json"],"url":"/tmp/.mount_old/tools/lint_registry/schemas/scenes.schema.json"}],\n}';
    writeFileSync(settings, config);
    const projects = new Projects(new LocalState(join(work, 'local')), REPO, 'linux');
    projects.open(project);
    const next = readFileSync(join(project, 'AGENTS.md'), 'utf8');
    expect(next.startsWith('Моё начало\n')).toBe(true);
    expect(next.endsWith('Моя команда и правило после блока\n')).toBe(true);
    expect(next).not.toContain('/tmp/.mount_old');
    expect(readFileSync(settings, 'utf8')).toBe(config.replace('/tmp/.mount_old/tools/', './.songframe/tools/'));
    const invalid = '{ // повреждён вручную';
    writeFileSync(settings, invalid);
    expect(() => projects.open(project)).toThrow(/Файл не изменён/);
    expect(readFileSync(settings, 'utf8')).toBe(invalid);
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).toBe(next);
    const foreign = join(work, 'Свой проект');
    json(join(foreign, 'plan/project.json'), { name: 'Свой проект' });
    writeFileSync(join(foreign, 'AGENTS.md'), 'Только мои правила');
    projects.open(foreign);
    expect(readFileSync(join(foreign, 'AGENTS.md'), 'utf8')).toBe('Только мои правила');
    expect(existsSync(join(foreign, '.songframe/README.md'))).toBe(true);
  });
  it.each([true, false])('подключает инструменты к проекту с пользовательскими правилами или без AGENTS.md (%s)', (withAgents) => {
    const project = join(work, 'Чужой проект');
    const local = join(work, 'local');
    json(join(project, 'plan/project.json'), { name: 'Чужой клип' });
    const agents = join(project, 'AGENTS.md');
    const readme = join(project, 'README.md');
    const settings = join(project, '.vscode/settings.json');
    const source = join(project, 'source/track.txt');
    const skill = join(project, '.agents/skills/ai-clip-scene/SKILL.md');
    if (withAgents) writeFileSync(agents, 'Мои правила без управляемого блока');
    writeFileSync(readme, 'Мои инструкции');
    mkdirSync(dirname(settings), { recursive: true });
    writeFileSync(settings, '{ повреждённые пользовательские настройки');
    mkdirSync(dirname(source), { recursive: true });
    writeFileSync(source, 'Исходные данные');
    mkdirSync(dirname(skill), { recursive: true });
    writeFileSync(skill, 'Мой навык');
    const projects = new Projects(new LocalState(local), REPO, 'linux', {
      appCommand: { command: process.execPath, args: [], localDir: local }
    });
    const result = projects.open(project);
    expect(existsSync(join(project, '.songframe/run-tool'))).toBe(true);
    expect(readFileSync(join(project, '.songframe/run-tool'), 'utf8')).toContain('--songframe-tool');
    expect(existsSync(agents)).toBe(withAgents);
    if (withAgents) expect(readFileSync(agents, 'utf8')).toBe('Мои правила без управляемого блока');
    expect(readFileSync(readme, 'utf8')).toBe('Мои инструкции');
    expect(readFileSync(settings, 'utf8')).toBe('{ повреждённые пользовательские настройки');
    expect(readFileSync(source, 'utf8')).toBe('Исходные данные');
    expect(readFileSync(skill, 'utf8')).toBe('Мой навык');
    expect(result.problems.some((problem) => problem.includes('пользовательский навык'))).toBe(true);
  });
  it('сохраняет пользовательские ссылки внутри служебной папки и не пишет по ним', () => {
    const project = join(work, 'Проект');
    const outside = join(work, 'Пользовательские файлы');
    json(join(project, 'plan/project.json'), { name: 'Клип' });
    mkdirSync(join(project, '.songframe'), { recursive: true });
    mkdirSync(outside);
    writeFileSync(join(outside, 'README.md'), 'Не изменять');
    symlinkSync(outside, join(project, '.songframe/tools'), 'dir');
    symlinkSync(join(outside, 'README.md'), join(project, '.songframe/run-tool'));
    const local = join(work, 'local');
    const result = new Projects(new LocalState(local), REPO, 'linux', {
      appCommand: { command: process.execPath, args: [], localDir: local }
    }).open(project);
    expect(readFileSync(join(outside, 'README.md'), 'utf8')).toBe('Не изменять');
    expect(readFileSync(join(project, '.songframe/run-tool'), 'utf8')).toBe('Не изменять');
    expect(result.problems.some((problem) => problem.includes('символическая ссылка'))).toBe(true);
    expect(existsSync(join(project, '.songframe/run-kling'))).toBe(true);
  });
  it('сохраняет ручные правила и данные при переносе проекта/приложения, launcher работает из чужого cwd', () => {
    const resources = join(work, 'Ресурсы');
    cpSync(join(REPO, 'templates'), join(resources, 'templates'), { recursive: true });
    json(join(resources, 'tools/common.py'), {});
    mkdirSync(join(resources, 'tools/lint_registry/schemas'), { recursive: true });
    writeFileSync(join(resources, 'tools/README.md'), '# Карта');
    cpSync(join(REPO, 'tools/lint_registry/schemas'), join(resources, 'tools/lint_registry/schemas'), { recursive: true });
    treePermissions(resources, false);
    const app = join(work, "App с пробелами и 'кавычкой'");
    writeFileSync(app, `#!${process.execPath}\nconsole.log(JSON.stringify({args: process.argv.slice(2), local: process.env.SONGFRAME_LOCAL_DIR}));\n`, {
      mode: 0o755
    });
    const local = join(work, 'Состояние');
    const state = new LocalState(local);
    const integration = { appCommand: { command: app, args: [], localDir: local } };
    const project = join(work, 'Первый клип');
    const projects = new Projects(state, resources, 'linux', integration);
    projects.create({ name: 'Клип', path: project });
    expect(readFileSync(join(project, 'AGENTS.md'), 'utf8')).not.toContain(resources);
    writeFileSync(join(project, 'AGENTS.md'), 'Моё правило до блока\n' + readFileSync(join(project, 'AGENTS.md'), 'utf8') + '\nМоё правило после блока');
    writeFileSync(join(project, 'source/text.md'), 'Исходник не изменять');
    json(join(project, 'plan/scenes.json'), { schema_version: 1, scenes: [{ id: 'M01', action: 'Ручная постановка' }] });
    const scenes = readFileSync(join(project, 'plan/scenes.json'));
    // Обновление AppImage при том же проекте обновляет launcher уже при восстановлении сессии.
    const updatedApp = join(work, 'Обновлённый AppImage');
    renameSync(app, updatedApp);
    const currentBefore = readFileSync(state.currentFile, 'utf8');
    new Projects(state, resources, 'linux', { appCommand: { command: updatedApp, args: [], localDir: local } }).restoreCurrent();
    expect(readFileSync(join(project, '.songframe/run-tool'), 'utf8')).toContain(updatedApp);
    expect(readFileSync(state.currentFile, 'utf8')).toBe(currentBefore);
    const moved = join(work, 'Перенесённый клип');
    const movedApp = join(work, 'Новый AppImage');
    renameSync(project, moved);
    renameSync(updatedApp, movedApp);
    const command = join(moved, '.songframe/run-tool');
    expect(spawnSync(command, ['check_workspace'], { cwd: '/' }).stderr.toString()).toContain('Откройте проект');
    const next = new Projects(state, resources, 'linux', { appCommand: { command: movedApp, args: [], localDir: local } });
    next.open(moved);
    const run = spawnSync(command, ['check_workspace', '--json'], { cwd: '/', encoding: 'utf8' });
    expect(run.status, run.stderr).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({ args: ['--songframe-tool', 'check_workspace', '--json', '--project', moved], local });
    const agents = readFileSync(join(moved, 'AGENTS.md'), 'utf8');
    expect(agents.startsWith('Моё правило до блока\n')).toBe(true);
    expect(agents.endsWith('Моё правило после блока')).toBe(true);
    expect(agents).not.toContain(work);
    expect(readFileSync(join(moved, 'source/text.md'), 'utf8')).toBe('Исходник не изменять');
    expect(readFileSync(join(moved, 'plan/scenes.json'))).toEqual(scenes);
    expect(readFileSync(join(moved, '.vscode/settings.json'), 'utf8')).not.toContain(resources);
    expect(existsSync(join(moved, '.songframe/tools/lint_registry/schemas/scenes.schema.json'))).toBe(true);
    expect(existsSync(join(moved, '.songframe/tools/common.py'))).toBe(false);
    expect(state.readCurrent()).toBe(moved);
  });
});

describe('CLI приложения', () => {
  it('передаёт аргументы общему launcher и возвращает код ошибки инструмента', async () => {
    const launcher = new PythonLauncher({ toolsRoot: work });
    const run = vi.spyOn(launcher, 'run').mockResolvedValue({ code: 7, stdout: '', stderr: '', command: '' });
    const output = vi.fn();
    expect(await runToolCli(launcher, ['check_workspace', '--project', 'Клип с пробелами', '--json'], output)).toBe(7);
    expect(run).toHaveBeenCalledWith(null, 'check_workspace', ['--project', 'Клип с пробелами', '--json'], expect.objectContaining({ onOutput: output }));
    expect(await runToolCli(launcher, [], output)).toBe(2);
  });
  it('настоящий current_project из CLI читает состояние приложения, ресурсы не используются для записи', async () => {
    const local = join(work, 'CLI-состояние');
    initializeLocalStorage(local);
    const project = join(work, 'Клип');
    json(join(project, 'plan/project.json'), { schema_version: 1, name: 'Клип' });
    const launcher = new PythonLauncher({ toolsRoot: REPO, localDir: local });
    let stdout = '';
    const output = (text: string, error?: boolean): void => {
      if (!error) stdout += text;
    };
    expect(await runToolCli(launcher, ['current_project', '--json', 'set', project], output)).toBe(0);
    expect(JSON.parse(stdout).path).toBe(project);
    expect(new LocalState(local).readCurrent()).toBe(project);
    stdout = '';
    expect(await runToolCli(launcher, ['current_project', '--json', 'show'], output)).toBe(0);
    expect(JSON.parse(stdout).source).toBe('current_file');
    const settings = new SettingsStore(local);
    settings.write({ toolsRootOverride: null });
    expect(existsSync(join(local, 'settings.json'))).toBe(true);
  });
});
