/** Перенос проекта меняет только служебные команды и памятки; Windows-CMD дополнительно проверяется нативно. */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderWindowsProjectLauncher } from './project-integration';
import { Projects } from './projects';
import { LocalState } from './state';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-windows-project-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));
const app = () => ({ command: 'C:\\Приложения 100% ! & (тест)\\SongFrame.exe', args: [], localDir: 'C:\\Данные %TEMP% !\\' });

describe('Windows-launcher проекта', () => {
  it('сохраняет UTF-8/CRLF, literal-пути и отдельные режимы без потери кода завершения', () => {
    const tool = renderWindowsProjectLauncher(app());
    expect(tool.charCodeAt(0)).not.toBe(0xfeff);
    expect(tool).not.toMatch(/(?<!\r)\n/);
    expect(tool).toContain('setlocal EnableExtensions DisableDelayedExpansion\r\n"%SystemRoot%\\System32\\chcp.com" 65001 >nul');
    expect(tool).toContain('set "SONGFRAME_LOCAL_DIR=C:\\Данные %%TEMP%% !\\"');
    expect(tool).toContain('"C:\\Приложения 100%% ! & (тест)\\SongFrame.exe" --songframe-tool %* --project "%~dp0.."\r\nexit /b %errorlevel%');
    const kling = renderWindowsProjectLauncher(app(), '--songframe-kling');
    expect(kling).toContain('--songframe-kling %*\r\nexit /b %errorlevel%');
    expect(kling).not.toContain('--project');
    expect(kling).not.toContain('call ');
    expect(kling).not.toContain('start ');
  });

  it('сохраняет dev-prefix и отказывает пути, не представимому в CMD', () => {
    const text = renderWindowsProjectLauncher({ ...app(), args: ['C:\\Dev %PATH%\\'] });
    expect(text).toContain('"C:\\Dev %%PATH%%\\\\" --songframe-tool');
    expect(() => renderWindowsProjectLauncher({ ...app(), command: 'C:\\bad"path' })).toThrow('Windows-launcher');
  });

  it('создаёт Windows-команды и памятки, обновляет их при переносе между ОС, сохраняя данные и правила', () => {
    const project = join(work, 'Клип с пробелами');
    const state = new LocalState(join(work, 'local'));
    const windows = new Projects(state, process.cwd(), 'win32', { appCommand: app() });
    windows.create({ name: 'Тест', path: project });
    const service = join(project, '.songframe');
    expect(existsSync(join(service, 'run-tool.cmd'))).toBe(true);
    expect(existsSync(join(service, 'run-kling.cmd'))).toBe(true);
    for (const file of ['AGENTS.md', 'README.md']) {
      const content = readFileSync(join(project, file), 'utf8');
      expect(content).toContain('.\\.songframe\\run-tool.cmd');
      expect(content).toContain('./.songframe/run-tool');
      expect(content).not.toContain('AppImage');
    }
    expect(readFileSync(join(service, 'README.md'), 'utf8')).toContain('.\\.songframe\\run-tool.cmd');
    const rules = join(project, 'AGENTS.md');
    writeFileSync(rules, 'Мои правила до\n' + readFileSync(rules, 'utf8') + '\nМои правила после');
    const readme = join(project, 'README.md');
    writeFileSync(readme, readFileSync(readme, 'utf8') + '\nМой текст README');
    const source = join(project, 'source/original.txt');
    writeFileSync(source, 'Мой исходник');
    writeFileSync(join(service, 'custom.cmd'), 'Мой файл');
    new Projects(state, process.cwd(), 'linux', { appCommand: { ...app(), command: '/opt/Приложение' } }).open(project);
    expect(existsSync(join(service, 'run-tool.cmd'))).toBe(false);
    expect(existsSync(join(service, 'run-tool'))).toBe(true);
    expect(readFileSync(readme, 'utf8')).toContain('./.songframe/run-tool');
    expect(readFileSync(readme, 'utf8')).toContain('run-tool.cmd');
    const movedApp = { ...app(), command: 'D:\\Новая поставка\\SongFrame.exe' };
    new Projects(state, process.cwd(), 'win32', { appCommand: movedApp }).open(project);
    expect(existsSync(join(service, 'run-tool'))).toBe(false);
    expect(readFileSync(join(service, 'run-tool.cmd'), 'utf8')).toContain(movedApp.command);
    expect(readFileSync(rules, 'utf8')).toMatch(/^Мои правила до\n[\s\S]*\nМои правила после$/);
    expect(readFileSync(readme, 'utf8')).toContain('Мой текст README');
    expect(readFileSync(source, 'utf8')).toBe('Мой исходник');
    expect(readFileSync(join(service, 'custom.cmd'), 'utf8')).toBe('Мой файл');
    expect(readFileSync(join(project, '.agents/skills/ai-clip-scene/SKILL.md'), 'utf8')).toContain('run-tool.cmd');
  });

  it('не меняет README без маркеров даже с текстом прежнего шаблона и примерами для обеих ОС', () => {
    const project = join(work, 'Legacy');
    const projects = new Projects(new LocalState(join(work, 'local')), process.cwd(), 'win32', { appCommand: app() });
    projects.create({ name: 'Тест', path: project });
    const readme = join(project, 'README.md');
    const original =
      '# Клип\nЭто единственная карта навигации проекта:\nПосле перемещения AppImage или проекта\nНа Linux запускайте его из папки клипа:\n```sh\n./.songframe/run-tool check_assets\n```\nДля Windows: `.\\.songframe\\run-tool.cmd check_assets`\n`~/.kling/.credentials`\nнапример `"/путь/к/songframe.AppImage" --songframe-kling --version`\nМоё пояснение';
    writeFileSync(readme, original);
    projects.open(project);
    expect(readFileSync(readme, 'utf8')).toBe(original);
    new Projects(new LocalState(join(work, 'local')), process.cwd(), 'linux', { appCommand: app() }).open(project);
    expect(readFileSync(readme, 'utf8')).toBe(original);
    writeFileSync(readme, 'Совсем мой README\n./.songframe/run-tool оставлен намеренно');
    projects.open(project);
    expect(readFileSync(readme, 'utf8')).toBe('Совсем мой README\n./.songframe/run-tool оставлен намеренно');
  });

  it('сохраняет пользовательские инструкции до и после управляемого блока при переносе между ОС', () => {
    const project = join(work, 'Две ОС');
    const state = new LocalState(join(work, 'local'));
    const windows = new Projects(state, process.cwd(), 'win32', { appCommand: app() });
    const linux = new Projects(state, process.cwd(), 'linux', { appCommand: app() });
    windows.create({ name: 'Тест', path: project });
    const path = join(project, 'README.md');
    const before = 'Linux: `./.songframe/run-tool check_assets`\nWindows: `.\\.songframe\\run-tool.cmd check_assets`\n';
    const after = '\nLinux: `./.songframe/run-kling login`\nWindows: `.\\.songframe\\run-kling.cmd login`\n';
    writeFileSync(path, before + readFileSync(path, 'utf8') + after);
    const original = readFileSync(path, 'utf8');
    const agents = join(project, 'AGENTS.md');
    const originalAgents = readFileSync(agents, 'utf8');
    for (const target of [linux, windows, linux, windows]) {
      target.open(project);
      const result = readFileSync(path, 'utf8');
      expect(result.startsWith(before)).toBe(true);
      expect(result.endsWith(after)).toBe(true);
      expect(result).toBe(original);
      expect(readFileSync(agents, 'utf8')).toBe(originalAgents);
    }
  });

  it.skipIf(process.platform !== 'win32')('передаёт Unicode, аргументы, проект и исходный exitCode настоящему CMD', () => {
    const project = join(work, 'Клип 100% ! & (тест)');
    const service = join(project, '.songframe');
    mkdirSync(service, { recursive: true });
    const script = join(work, 'Команда.js');
    writeFileSync(script, 'console.log(JSON.stringify({args:process.argv.slice(2),local:process.env.SONGFRAME_LOCAL_DIR}));process.exitCode=7;');
    for (const mode of ['--songframe-tool', '--songframe-kling'] as const) {
      const file = join(service, mode === '--songframe-tool' ? 'run-tool.cmd' : 'run-kling.cmd');
      writeFileSync(file, renderWindowsProjectLauncher({ ...app(), command: process.execPath, args: [script] }, mode));
      const result = spawnSync(process.env.ComSpec ?? 'cmd.exe', ['/d', '/s', '/c', `""${file}" "русский аргумент" "a&b""`], {
        windowsVerbatimArguments: true,
        encoding: 'utf8'
      });
      expect(result.status, result.stderr).toBe(7);
      const data = JSON.parse(result.stdout);
      expect(data.local).toBe(app().localDir);
      expect(data.args.slice(0, 3)).toEqual([mode, 'русский аргумент', 'a&b']);
      expect(data.args.includes('--project')).toBe(mode === '--songframe-tool');
    }
  });
});
