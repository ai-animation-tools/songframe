/** GUI PATH согласуется с Node shebang и default nvm без изменений окружения вызывающего процесса. */
import { execFile } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { externalEnvironment } from './external-environment';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-external-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function binary(directory: string, name: string, body = '#!/bin/sh\nexit 0\n'): string {
  mkdirSync(directory, { recursive: true });
  const file = join(directory, name);
  writeFileSync(file, body, { mode: 0o755 });
  return file;
}

function nvm(directory: string, body: string): void {
  mkdirSync(directory, { recursive: true });
  writeFileSync(join(directory, 'nvm.sh'), body);
}

function cliVersion(command: string, env: NodeJS.ProcessEnv): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(command, ['--version'], { env, timeout: 1000 }, (error, stdout) => (error ? reject(error) : resolve(stdout.trim())));
  });
}

describe.skipIf(process.platform !== 'linux')('Окружение внешних CLI на Linux', () => {
  it('сохраняет уже выбранный node и не переключает его на другой NVM_BIN', async () => {
    const existing = join(work, 'current');
    const other = join(work, 'other');
    binary(existing, 'node');
    binary(other, 'node');
    const input = Object.freeze({ PATH: existing, NVM_BIN: other, HOME: work });
    const processPath = process.env.PATH;
    const env = await externalEnvironment({ env: input, home: work, platform: 'linux' });
    expect(env.PATH?.split(':')[0]).toBe(existing);
    expect(env.PATH?.split(':')).not.toContain(other);
    expect(input.PATH).toBe(existing);
    expect(process.env.PATH).toBe(processPath);
    expect(env).not.toBe(input);
  });

  it('подключает валидный NVM_BIN к минимальному GUI PATH и реально запускает CLI с Node shebang', async () => {
    const bin = join(work, 'CLI с пробелами');
    binary(bin, 'node', '#!/bin/sh\nprintf "node-wrapper:%s\\n" "$*"\n');
    const cli = binary(bin, 'test-cli', '#!/usr/bin/env node\n');
    const env = await externalEnvironment({ env: { PATH: '/usr/bin:/bin', NVM_BIN: bin }, home: work, platform: 'linux' });
    expect(env.PATH?.split(':')[0]).toBe(bin);
    expect(await cliVersion('test-cli', env)).toBe(`node-wrapper:${cli} --version`);
  });

  it('использует штатный nvm which default из NVM_DIR вместо обхода каталогов версий', async () => {
    const directory = join(work, 'custom nvm');
    const node = binary(join(directory, 'selected bin'), 'node');
    const profile = join(work, 'unexpected-profile');
    writeFileSync(profile, 'exit 11\n');
    nvm(
      directory,
      `printf 'startup output is ignored\\n'\nprintf '%s' "$1" > "$NVM_DIR/source-argument"\nnvm() { [ "$*" = 'which default' ] || return 9; printf '%s\\n' "$NVM_DIR/selected bin/node"; }\n`
    );
    const env = await externalEnvironment({
      env: { PATH: '/usr/bin:/bin', NVM_DIR: directory, NVM_BIN: join(work, 'missing'), BASH_ENV: profile },
      home: work,
      platform: 'linux'
    });
    expect(env.PATH?.split(':')[0]).toBe(join(directory, 'selected bin'));
    expect(await cliVersion(node, env)).toBe('');
    expect(readFileSync(join(directory, 'source-argument'), 'utf8')).toBe('--no-use');
  });

  it.each(['home', 'xdg'] as const)('находит официальный каталог nvm для %s без интерактивного профиля', async (location) => {
    const nvmDir = location === 'home' ? join(work, '.nvm') : join(work, 'config/nvm');
    const bin = join(nvmDir, 'selected');
    binary(bin, 'node');
    nvm(nvmDir, 'nvm() { [ "$*" = "which default" ] || return 9; printf "%s\\n" "$NVM_DIR/selected/node"; }\n');
    const env = await externalEnvironment({
      env: { PATH: '/usr/bin:/bin', ...(location === 'xdg' ? { XDG_CONFIG_HOME: join(work, 'config') } : {}) },
      home: work,
      platform: 'linux'
    });
    expect(env.PATH?.split(':')[0]).toBe(bin);
  });

  it('возвращает базовый PATH после ошибки resolver и ограничивает зависший resolver без блокировки event loop', async () => {
    const directory = join(work, '.nvm');
    nvm(directory, 'nvm() { return 7; }\n');
    const options = { env: { PATH: '/usr/bin:/bin' }, home: work, platform: 'linux' as const, timeoutMs: 30 };
    const failed = await externalEnvironment(options);
    expect(failed.PATH?.split(':')[0]).toBe('/usr/bin');
    nvm(directory, 'nvm() { while :; do :; done; }\n');
    let heartbeat = false;
    const timer = setTimeout(() => {
      heartbeat = true;
    }, 0);
    const started = performance.now();
    const timedOut = await externalEnvironment(options);
    clearTimeout(timer);
    expect(heartbeat).toBe(true);
    expect(performance.now() - started).toBeLessThan(1000);
    expect(timedOut).toEqual(failed);
  });
});

it('сохраняет Windows PATH и переменные без POSIX-каталогов и без изменения входного объекта', async () => {
  const input = Object.freeze({ PATH: 'C:\\Windows;C:\\node', NVM_BIN: '/unused', SONGFRAME_TEST_MARKER: '/unused/marker' });
  const env = await externalEnvironment({ env: input, home: '/unused', platform: 'win32' });
  expect(env).toEqual(input);
  expect(env).not.toBe(input);
});
