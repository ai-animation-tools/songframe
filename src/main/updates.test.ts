/** Обновления проверяются на подставном GitHub: без сети, с настоящими файлами во временной папке. */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updatesTexts } from '@shared/texts/updates';
import { AppUpdates, newer, packageName, relaunchArgs, relaunchEnvironment, releasePackage, RELEASE_REPOSITORY, type UpdateOptions } from './updates';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'Обновления '));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const PACKAGE = Buffer.from('новая версия приложения');
const download = (version: string, name: string): string => `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${name}`;

function release(version: string, platform: NodeJS.Platform = 'linux', bytes = PACKAGE): Record<string, unknown> {
  const name = packageName(version, platform)!;
  return {
    tag_name: `v${version}`,
    draft: false,
    prerelease: false,
    assets: [
      { name: `${name}.sha256`, size: 10, digest: `sha256:${'0'.repeat(64)}`, browser_download_url: download(version, `${name}.sha256`) },
      { name, size: bytes.length, digest: `sha256:${createHash('sha256').update(bytes).digest('hex')}`, browser_download_url: download(version, name) }
    ]
  };
}

function github(latest: Record<string, unknown> | number, served = PACKAGE): typeof fetch {
  return vi.fn(async (input: string | URL | Request) => {
    const url = String(input);
    if (url.endsWith('/releases/latest')) return typeof latest === 'number' ? new Response('', { status: latest }) : Response.json(latest);
    if (url.startsWith(`https://github.com/${RELEASE_REPOSITORY}/releases/download/`)) return new Response(served);
    return new Response('', { status: 404 });
  }) as unknown as typeof fetch;
}

function updates(options: Partial<UpdateOptions> & { fetch: typeof fetch }): AppUpdates & { calls: Record<string, unknown[]> } {
  const calls: Record<string, unknown[]> = { launch: [], relaunch: [], quit: [], reveal: [] };
  const service = new AppUpdates({
    currentVersion: '0.2.0',
    platform: 'linux',
    directory: join(work, 'state', 'updates'),
    launch: (file) => calls.launch.push(file),
    relaunch: (path) => calls.relaunch.push(path),
    quit: () => calls.quit.push(true),
    reveal: (file) => calls.reveal.push(file),
    ...options
  });
  return Object.assign(service, { calls });
}

describe('Описание выпуска', () => {
  it('сравнивает версии X.Y.Z по числам', () => {
    expect(newer('0.10.0', '0.9.9')).toBe(true);
    expect(newer('1.0.0', '0.99.99')).toBe(true);
    expect(newer('0.2.0', '0.2.0')).toBe(false);
    expect(newer('0.1.9', '0.2.0')).toBe(false);
  });

  it('берёт пакет своей ОС и отклоняет чужой адрес, пустой digest, черновик и неподдерживаемую ОС', () => {
    expect(releasePackage(release('0.3.0', 'win32'), 'win32')).toMatchObject({
      version: '0.3.0',
      name: 'songframe-0.3.0-win-x64-setup.exe',
      page: `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v0.3.0`,
      size: PACKAGE.length
    });
    const value = release('0.3.0');
    const asset = (value.assets as Record<string, unknown>[])[1];
    expect(() => releasePackage({ ...value, draft: true }, 'linux')).toThrow(updatesTexts.invalidRelease);
    expect(() => releasePackage({ ...value, tag_name: 'v0.3.0-beta' }, 'linux')).toThrow(updatesTexts.invalidRelease);
    expect(() => releasePackage({ ...value, assets: [{ ...asset, browser_download_url: 'https://example.com/songframe.AppImage' }] }, 'linux')).toThrow(
      updatesTexts.invalidRelease
    );
    expect(() => releasePackage({ ...value, assets: [{ ...asset, digest: null }] }, 'linux')).toThrow(updatesTexts.invalidRelease);
    expect(() => releasePackage(value, 'win32')).toThrow(updatesTexts.packageMissing);
    expect(() => releasePackage(value, 'darwin')).toThrow(updatesTexts.packageMissing);
  });
});

describe('Проверка и скачивание', () => {
  it('сообщает об актуальной версии и об ошибке GitHub, не предлагая скачивание', async () => {
    expect(await updates({ fetch: github(release('0.2.0')) }).check()).toEqual({
      status: 'current',
      currentVersion: '0.2.0',
      message: updatesTexts.current
    });
    expect(await updates({ fetch: github(403) }).check()).toMatchObject({ status: 'error', message: updatesTexts.checkFailed });
    expect(await updates({ fetch: github(403) }).download()).toMatchObject({ status: 'error', message: updatesTexts.checkFirst });
  });

  it('скачивает новую версию, сверяет SHA-256 и оставляет в папке только её', async () => {
    const directory = join(work, 'state', 'updates');
    const service = updates({ fetch: github(release('0.3.0')), directory });
    expect(await service.check()).toMatchObject({ status: 'available', version: '0.3.0', installable: false });
    // Прежний пакет в папке обновлений удаляется, соседние данные каталога состояния остаются.
    mkdirSync(directory, { recursive: true });
    writeFileSync(join(directory, 'songframe-0.2.1-linux-x86_64.AppImage'), 'прежний пакет');
    writeFileSync(join(work, 'state', 'settings.json'), '{}');
    const ready = await service.download();
    expect(ready).toMatchObject({ status: 'ready', version: '0.3.0', message: `${updatesTexts.ready({ version: '0.3.0' })} ${updatesTexts.readyManual}` });
    expect(readdirSync(directory)).toEqual(['songframe-0.3.0-linux-x86_64.AppImage']);
    expect(readFileSync(join(directory, 'songframe-0.3.0-linux-x86_64.AppImage'))).toEqual(PACKAGE);
    expect(existsSync(join(work, 'state', 'settings.json'))).toBe(true);
  });

  it('удаляет пакет, не совпавший с контрольной суммой, и разрешает повторить скачивание', async () => {
    const directory = join(work, 'updates');
    const service = updates({ fetch: github(release('0.3.0'), Buffer.from('подменённый пакет приложения')), directory });
    await service.check();
    expect(await service.download()).toMatchObject({ status: 'error', version: '0.3.0', message: updatesTexts.hashMismatch });
    expect(readdirSync(directory)).toEqual([]);
    expect(await service.install()).toMatchObject({ status: 'error', message: updatesTexts.checkFirst });
  });
});

describe('Установка', () => {
  it('в Linux заменяет запущенный AppImage, делает его исполняемым и перезапускает приложение', async () => {
    const appImage = join(work, 'Приложения', 'SongFrame.AppImage');
    mkdirSync(join(work, 'Приложения'));
    writeFileSync(appImage, 'старая версия', { mode: 0o755 });
    const service = updates({ fetch: github(release('0.3.0')), appImage });
    expect(await service.check()).toMatchObject({ installable: true });
    expect(await service.download()).toMatchObject({ status: 'ready', message: updatesTexts.ready({ version: '0.3.0' }) });
    await service.install();
    expect(readFileSync(appImage)).toEqual(PACKAGE);
    expect(statSync(appImage).mode & 0o777).toBe(0o755);
    expect(readdirSync(join(work, 'Приложения'))).toEqual(['SongFrame.AppImage']);
    expect(service.calls).toMatchObject({ relaunch: [appImage], quit: [true], launch: [], reveal: [] });
  });

  it('в Windows запускает скачанный установщик и закрывает приложение, без AppImage показывает файл', async () => {
    const windows = updates({ fetch: github(release('0.3.0', 'win32')), platform: 'win32' });
    await windows.check();
    await windows.download();
    await windows.install();
    expect(windows.calls).toMatchObject({ launch: [join(work, 'state', 'updates', 'songframe-0.3.0-win-x64-setup.exe')], quit: [true] });

    const manual = updates({ fetch: github(release('0.3.0')) });
    await manual.check();
    await manual.download();
    await manual.install();
    expect(manual.calls).toMatchObject({ reveal: [join(work, 'state', 'updates', 'songframe-0.3.0-linux-x86_64.AppImage')], quit: [], relaunch: [] });
  });
});

describe.skipIf(process.platform !== 'linux')('Перезапуск AppImage', () => {
  it('убирает из окружения переменные и пути старого монтирования, сохраняя остальные', () => {
    const mount = '/tmp/.mount_SongFrAbc123';
    expect(
      relaunchEnvironment({
        APPDIR: mount,
        APPIMAGE: '/home/u/SongFrame.AppImage',
        ARGV0: './SongFrame.AppImage',
        OWD: '/home/u',
        PATH: `${mount}:${mount}/usr/sbin:/usr/bin:/bin`,
        LD_LIBRARY_PATH: `${mount}/usr/lib`,
        HOME: '/home/u'
      })
    ).toEqual({ PATH: '/usr/bin:/bin', HOME: '/home/u' });
  });

  it('ждёт выхода процесса, закрывает унаследованные дескрипторы и запускает новый файл', async () => {
    const report = join(work, 'report');
    const appImage = join(work, 'Новый SongFrame.AppImage');
    writeFileSync(appImage, `#!/bin/sh\n[ -e /proc/$$/fd/3 ] && echo open > "$REPORT" || echo closed > "$REPORT"\n`, { mode: 0o755 });
    const running = spawn('sleep', ['0.5']);
    const exited = new Promise((resolve) => running.once('exit', resolve));
    const inherited = openSync(join(work, 'файл старого монтирования'), 'w');
    const relaunch = spawn('/bin/bash', relaunchArgs(running.pid!, appImage), {
      stdio: ['ignore', 'ignore', 'ignore', inherited],
      env: { ...process.env, REPORT: report }
    });
    closeSync(inherited);
    await new Promise((resolve) => setTimeout(resolve, 200));
    expect(existsSync(report)).toBe(false);
    await exited;
    await new Promise((resolve) => relaunch.once('exit', resolve));
    expect(readFileSync(report, 'utf8')).toBe('closed\n');
  });
});
