/** Поиск и запуск CLI в Windows проверяются в Linux: платформа передаётся явно, обёртки npm запускают настоящий Node. */
import { spawn } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agentCommand, findExecutable, killProcessTree } from './agent-command';
import { agentEnvironment, checkAgent } from './agents';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'Команда агента '));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function file(path: string, body = ''): string {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, body, { mode: 0o700 });
  return path;
}

/** Обёртка, которую npm создаёт в %APPDATA%\npm для глобального пакета. */
function shim(path: string, target: string): string {
  return file(
    path,
    [
      '@ECHO off',
      'GOTO start',
      ':find_dp0',
      'SET dp0=%~dp0',
      'EXIT /b',
      ':start',
      'SETLOCAL',
      'CALL :find_dp0',
      'IF EXIST "%dp0%\\node.exe" (',
      '  SET "_prog=%dp0%\\node.exe"',
      ') ELSE (',
      '  SET "_prog=node"',
      '  SET PATHEXT=%PATHEXT:;.JS;=;%',
      ')',
      `endLocal & goto #_undefined_# 2>NUL || title %COMSPEC% & "%_prog%"  "%dp0%\\${target}" %*`,
      ''
    ].join('\r\n')
  );
}

describe('Поиск CLI в Windows', () => {
  it('берёт .exe раньше .cmd, пропускает файл без расширения и относительные записи PATH', async () => {
    const first = join(work, 'first');
    const second = join(work, 'second');
    file(join(first, 'codex'));
    file(join(first, 'codex.cmd'));
    file(join(first, 'codex.exe'));
    file(join(second, 'claude.cmd'));
    const env = { Path: ['relative', first, second].join(delimiter) };
    expect(await findExecutable('codex', env, 'win32')).toBe(join(first, 'codex.exe'));
    expect(await findExecutable('claude', env, 'win32')).toBe(join(second, 'claude.cmd'));
    expect(await findExecutable('node', env, 'win32')).toBeUndefined();
    expect(await checkAgent({ provider: 'claude' }, { env: { Path: '' }, home: work, platform: 'win32' })).toMatchObject({
      availability: 'not_found',
      message: 'Claude Code не найден в PATH, %USERPROFILE%\\.local\\bin и %APPDATA%\\npm. Установите его по официальной инструкции и повторите проверку.'
    });
  });

  it('дополняет Path каталогами установок Windows, не создавая второй переменной PATH', () => {
    const home = join(work, 'home');
    const env = agentEnvironment(
      { Path: join(work, 'bin'), APPDATA: join(work, 'Roaming'), ProgramFiles: join(work, 'Program Files') },
      home,
      undefined,
      'win32'
    );
    expect(Object.keys(env).filter((key) => key.toUpperCase() === 'PATH')).toEqual(['Path']);
    expect(env.Path!.split(delimiter)).toEqual([
      join(work, 'bin'),
      join(home, '.local', 'bin'),
      join(work, 'Roaming', 'npm'),
      join(work, 'Program Files', 'nodejs')
    ]);
  });
});

describe('Запуск обёрток npm без shell', () => {
  it('разворачивает обёртку в вызов скрипта через node.exe рядом с ней или из PATH', async () => {
    const npm = join(work, 'npm');
    const wrapper = shim(join(npm, 'codex.cmd'), 'node_modules\\@openai\\codex\\bin\\codex.js');
    const script = join(npm, 'node_modules', '@openai', 'codex', 'bin', 'codex.js');
    const node = file(join(work, 'nodejs', 'node.exe'));
    const env = { Path: [npm, dirname(node)].join(delimiter) };
    expect(await agentCommand(wrapper, ['exec', '-'], env, 'win32')).toEqual({ file: node, args: [script, 'exec', '-'] });
    expect(await agentCommand('codex', ['--version'], env, 'win32')).toEqual({ file: node, args: [script, '--version'] });
    const local = file(join(npm, 'node.exe'));
    expect(await agentCommand(wrapper, [], env, 'win32')).toEqual({ file: local, args: [script] });
  });

  it('запускает программу из обёртки напрямую, а непонятную обёртку и Linux не меняет', async () => {
    const wrapper = shim(join(work, 'claude.cmd'), 'node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe');
    expect(await agentCommand(wrapper, ['-p'], {}, 'win32')).toEqual({
      file: join(work, 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe'),
      args: ['-p']
    });
    const other = file(join(work, 'other.cmd'), '@echo off\r\nclaude.exe %*\r\n');
    expect(await agentCommand(other, ['-p'], {}, 'win32')).toEqual({ file: other, args: ['-p'] });
    expect(await agentCommand(wrapper, ['-p'], {}, 'linux')).toEqual({ file: wrapper, args: ['-p'] });
  });

  it('проверяет версию и вход Codex через обёртку npm и Node из Program Files', async () => {
    const roaming = join(work, 'AppData', 'Roaming');
    const programFiles = join(work, 'Program Files');
    shim(join(roaming, 'npm', 'codex.cmd'), 'node_modules\\@openai\\codex\\bin\\codex.js');
    file(
      join(roaming, 'npm', 'node_modules', '@openai', 'codex', 'bin', 'codex.js'),
      `const args = process.argv.slice(2);
      if (JSON.stringify(args) === '["--version"]') console.log('codex-cli 0.159.2');
      else if (JSON.stringify(args) === '["login","status"]') console.log('Logged in using ChatGPT');
      else process.exit(99);`
    );
    // В Linux node.exe — ссылка на текущий Node: так запускается настоящий скрипт из обёртки.
    mkdirSync(join(programFiles, 'nodejs'), { recursive: true });
    symlinkSync(process.execPath, join(programFiles, 'nodejs', 'node.exe'));
    const result = await checkAgent({ provider: 'codex' }, { env: { Path: '', APPDATA: roaming, ProgramFiles: programFiles }, home: work, platform: 'win32' });
    expect(result).toMatchObject({
      executablePath: join(roaming, 'npm', 'codex.cmd'),
      availability: 'available',
      version: '0.159.2',
      authorization: 'authenticated'
    });
  });
});

describe('Завершение дерева процессов', () => {
  it('в Windows вызывает taskkill из SystemRoot для живого процесса и не трогает завершённый', async () => {
    const calls = join(work, 'calls');
    file(
      join(work, 'Windows', 'System32', 'taskkill.exe'),
      `#!${process.execPath}\nrequire('node:fs').appendFileSync(${JSON.stringify(calls)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n`
    );
    const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
    const closed = new Promise((resolve) => child.once('close', resolve));
    await new Promise((resolve) => child.once('spawn', resolve));
    killProcessTree(child, { SystemRoot: join(work, 'Windows') }, 'win32');
    expect(readFileSync(calls, 'utf8')).toBe(`${JSON.stringify(['/pid', String(child.pid), '/T', '/F'])}\n`);
    child.kill('SIGKILL');
    await closed;
    killProcessTree(child, { SystemRoot: join(work, 'Windows') }, 'win32');
    expect(readFileSync(calls, 'utf8').trim().split('\n')).toHaveLength(1);
  });
});
