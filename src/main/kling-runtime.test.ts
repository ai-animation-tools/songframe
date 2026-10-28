/** Контракт поставки Kling: переносимый bundle, аргументы без shell и флаг Node только у дочернего процесса. */
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { klingPaths, resolveKling, runKling, type KlingRuntimeOptions } from './kling-runtime';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-kling-runtime-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function bundle(resourcesPath: string, body?: string): void {
  const root = join(resourcesPath, 'kling');
  mkdirSync(join(root, 'dist'), { recursive: true });
  writeFileSync(join(root, 'package.json'), JSON.stringify({ name: '@klingai/cli-global', version: '0.2.3', type: 'module' }));
  writeFileSync(
    join(root, 'dist/cli.js'),
    body ??
      `import { readFileSync } from 'node:fs';
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'));
console.log(JSON.stringify({ name: pkg.name, version: pkg.version, args: process.argv.slice(2), flag: process.env.ELECTRON_RUN_AS_NODE, noninteractive: process.env.KLING_NONINTERACTIVE, file: import.meta.url }));
console.error('diagnostic');
`
  );
}

const options = (resourcesPath: string): KlingRuntimeOptions => ({ toolsRoot: resourcesPath, resourcesPath, packaged: true, execPath: process.execPath });

describe('Runtime официального Kling CLI', () => {
  it('завершает вход по полному JSON после сохранения, даже если CLI удерживает браузерный helper', async () => {
    bundle(work, `process.stdout.write('{"ok":true,'); setTimeout(() => process.stdout.write('"loggedIn":true}\\n'), 20); setInterval(() => {}, 1000);`);
    const result = await runKling(options(work), ['login', '--quiet'], { timeoutMs: 1500 });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({ ok: true, loggedIn: true });
    expect(result.stderr).not.toContain('Превышено время');
  });

  it('не принимает сообщение браузера или неполный JSON за сохранённый вход', async () => {
    bundle(work, `console.error('Login successful'); process.stdout.write('{"ok":true,'); setInterval(() => {}, 1000);`);
    const result = await runKling(options(work), ['login'], { timeoutMs: 150 });
    expect(result.code).toBeNull();
    expect(result.stderr).toContain('Превышено время');
  });

  it('не применяет подтверждение login к другим командам', async () => {
    bundle(work, `console.log(JSON.stringify({ok:true,loggedIn:true})); process.exitCode = 7;`);
    expect(await runKling(options(work), ['who_am_i'])).toMatchObject({ code: 7 });
  });

  it('возвращает timeout, даже если потомок CLI удерживает унаследованные трубы', async () => {
    bundle(
      work,
      `import { spawn } from 'node:child_process'; spawn(process.execPath, ['-e', 'setTimeout(() => {}, 1500)'], {stdio:'inherit'}).unref(); setInterval(() => {}, 1000);`
    );
    const started = performance.now();
    expect((await runKling(options(work), ['test'], { timeoutMs: 200 })).code).toBeNull();
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('использует настоящую папку ресурсов при appPath внутри ASAR', async () => {
    bundle(work);
    const archive = join(work, 'app.asar');
    writeFileSync(archive, 'archive');
    const result = await runKling({ ...options(work), toolsRoot: archive }, ['--version']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ version: '0.2.3' });
  });

  it('получает версию и сохраняет аргументы с пробелами и shell-символами через собственный executable', async () => {
    const resources = join(work, 'Приложение с пробелами');
    bundle(resources);
    const settings = options(resources);
    const originalFlag = process.env.ELECTRON_RUN_AS_NODE;
    const env = Object.freeze({ PATH: '', SONGFRAME_MARKER: 'caller' });
    settings.env = env;
    const args = ['--version', 'кадр с пробелами', 'a&b;$HOME', '"quoted"'];
    const outputs: { text: string; error?: boolean }[] = [];
    const result = await runKling(settings, args, { onOutput: (text, error) => outputs.push({ text, error }) });
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ name: '@klingai/cli-global', version: '0.2.3', args, flag: '1', noninteractive: '1' });
    expect(result.stderr).toBe('diagnostic\n');
    expect(outputs.some(({ error, text }) => error && text.includes('diagnostic'))).toBe(true);
    expect(outputs.some(({ error, text }) => !error && text.includes('0.2.3'))).toBe(true);
    expect(env).toEqual({ PATH: '', SONGFRAME_MARKER: 'caller' });
    expect(process.env.ELECTRON_RUN_AS_NODE).toBe(originalFlag);
    expect(resolveKling(settings)).toMatchObject({
      bundled: true,
      command: process.execPath,
      argsPrefix: [join(resources, 'kling/dist/cli.js')],
      version: '0.2.3'
    });
  });

  it('находит тот же неизменённый пакет после переноса папки приложения', async () => {
    const before = join(work, 'before');
    const after = join(work, 'Новая папка приложения');
    bundle(before);
    renameSync(before, after);
    const paths = klingPaths(options(after))!;
    expect(paths).toEqual({ executable: process.execPath, script: join(after, 'kling/dist/cli.js'), packageFile: join(after, 'kling/package.json') });
    const result = await runKling(options(after), ['--version']);
    expect(result.code).toBe(0);
    expect(JSON.parse(result.stdout)).toMatchObject({ version: '0.2.3' });
    expect(result.stdout).not.toContain(before);
  });

  it('оставляет явный CLI override внешним и не добавляет ему Electron-флаг', async () => {
    const settings = { ...options(work), env: { SONGFRAME_KLING_CLI: process.execPath, PATH: '' } };
    const runtime = resolveKling(settings);
    expect(runtime).toMatchObject({ bundled: false, command: process.execPath, argsPrefix: [] });
    expect(runtime.env.ELECTRON_RUN_AS_NODE).toBeUndefined();
    const result = await runKling(settings, ['-e', 'console.log("external override")']);
    expect(result).toMatchObject({ code: 0, stdout: 'external override\n' });
  });

  it('не маскирует отсутствующий или повреждённый packaged bundle внешним CLI', () => {
    const settings = { ...options(work), env: { PATH: '/usr/bin' } };
    expect(klingPaths(settings)).not.toBeNull();
    expect(() => resolveKling(settings)).toThrow('Встроенный Kling недоступен');
    bundle(work);
    rmSync(join(work, 'kling/dist/cli.js'));
    expect(() => resolveKling(settings)).toThrow('Встроенный Kling недоступен');
    bundle(work);
    writeFileSync(join(work, 'kling/package.json'), JSON.stringify({ name: 'other-cli', version: '0.2.3' }));
    expect(() => resolveKling(settings)).toThrow('Встроенный Kling недоступен');
  });

  it.each([
    { name: '@klingai/cli-cn', version: '0.2.3' },
    { name: 'songframe', version: '0.1.0' },
    { name: '@klingai/cli-global', version: '' },
    { name: '@klingai/cli-global', version: 23 },
    { name: '@klingai/cli-global' }
  ])('не подменяет global locale и настоящую версию чужим manifest: %j', (pkg) => {
    bundle(work);
    writeFileSync(join(work, 'kling/package.json'), JSON.stringify(pkg));
    expect(() => resolveKling(options(work))).toThrow('Не найден manifest пакета Kling');
  });

  it('использует dev fallback только до появления подготовленного каталога', () => {
    const settings = { toolsRoot: work, packaged: false, env: { PATH: 'external-path' } };
    expect(klingPaths(settings)).toBeNull();
    expect(resolveKling(settings)).toMatchObject({ bundled: false, command: 'kling', argsPrefix: [] });
    mkdirSync(join(work, 'build/runtime/kling'), { recursive: true });
    expect(klingPaths(settings)?.script).toBe(join(work, 'build/runtime/kling/dist/cli.js'));
    expect(() => resolveKling(settings)).toThrow('Встроенный Kling недоступен');
  });

  it('возвращает настоящий код ошибки и ограничивает зависший процесс без блокировки event loop', async () => {
    bundle(work, 'console.error("CLI failure"); process.exitCode = 7;');
    expect(await runKling(options(work), ['test'])).toMatchObject({ code: 7, stderr: 'CLI failure\n' });
    bundle(work, 'setInterval(() => {}, 1000);');
    let heartbeat = false;
    const timer = setTimeout(() => {
      heartbeat = true;
    }, 0);
    const started = performance.now();
    const result = await runKling(options(work), ['login'], { timeoutMs: 40 });
    clearTimeout(timer);
    expect(heartbeat).toBe(true);
    expect(result.code).toBeNull();
    expect(result.stderr).toContain('Превышено время выполнения Kling (40 мс).');
    expect(performance.now() - started).toBeLessThan(1500);
  });
});
