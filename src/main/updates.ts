/**
 * Обновление приложения по явному действию пользователя: последний выпуск GitHub, скачивание пакета своей ОС
 * и сверка с digest SHA-256 из GitHub API, тем же, что проверяет `yarn release publish`.
 * Собственная подпись не нужна: пакеты и описание выпуска публикует только владелец репозитория.
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmod, copyFile, mkdir, open, rename, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { updatesTexts } from '@shared/texts/updates';
import type { UpdateView } from '@shared/updates';

export const RELEASE_REPOSITORY = 'ai-animation-tools/songframe';
const LATEST_URL = `https://api.github.com/repos/${RELEASE_REPOSITORY}/releases/latest`;

export interface UpdatePackage {
  version: string;
  page: string;
  name: string;
  size: number;
  sha256: string;
  url: string;
}

export interface UpdateOptions {
  currentVersion: string;
  platform: NodeJS.Platform;
  /** Папка скачанных пакетов в каталоге состояния; при новом скачивании очищается. */
  directory: string;
  fetch?: typeof fetch;
  /** Путь запущенного AppImage из переменной APPIMAGE; без него Linux-пакет заменяется вручную. */
  appImage?: string;
  launch: (file: string) => void;
  relaunch: (execPath: string) => void;
  quit: () => void;
  reveal: (file: string) => void;
}

class UpdateError extends Error {}

/**
 * app.relaunch запускает помощника из смонтированного AppImage, а точка монтирования исчезает вместе с приложением.
 * Поэтому новый AppImage запускает системный bash после выхода этого процесса. Chromium держит файлы монтирования
 * открытыми без CLOEXEC, а AppRun дописывает его пути в окружение: и то и другое не передаём, иначе старый
 * AppImage остался бы смонтирован до закрытия новой версии.
 */
export function relaunchEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const mount = env.APPDIR;
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    if (['APPIMAGE', 'APPDIR', 'ARGV0', 'OWD'].includes(key) || value === undefined) continue;
    if (!mount || !value.includes(mount)) {
      result[key] = value;
      continue;
    }
    const rest = value.split(':').filter((part) => part && !part.startsWith(mount));
    if (rest.length) result[key] = rest.join(':');
  }
  return result;
}

/** Аргументы bash: дождаться выхода pid, закрыть унаследованные дескрипторы и запустить AppImage. */
export function relaunchArgs(pid: number, appImage: string): string[] {
  const script = [
    'while kill -0 "$1" 2>/dev/null; do sleep 0.2; done',
    'for fd in /proc/$$/fd/*; do fd=${fd##*/}; [ "$fd" -gt 2 ] && eval "exec $fd<&-"; done 2>/dev/null',
    'exec "$2"'
  ].join('\n');
  return ['-c', script, 'songframe-relaunch', String(pid), appImage];
}

export function relaunchAppImage(appImage: string): void {
  spawn('/bin/bash', relaunchArgs(process.pid, appImage), {
    detached: true,
    stdio: 'ignore',
    env: relaunchEnvironment(process.env)
  }).unref();
}

/** Имена пакетов совпадают с комплектом `yarn release`. */
export function packageName(version: string, platform: NodeJS.Platform): string | null {
  if (platform === 'linux') return `songframe-${version}-linux-x86_64.AppImage`;
  if (platform === 'win32') return `songframe-${version}-win-x64-setup.exe`;
  return null;
}

/** Версии выпусков — X.Y.Z без prerelease. */
export function newer(candidate: string, current: string): boolean {
  const left = candidate.split('.').map(Number);
  const right = current.split('.').map(Number);
  for (let index = 0; index < 3; index++) if (left[index] !== right[index]) return (left[index] ?? 0) > (right[index] ?? 0);
  return false;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

/** Пакет выпуска для своей ОС; адрес обязан быть версионной ссылкой этого репозитория. */
export function releasePackage(value: unknown, platform: NodeJS.Platform): UpdatePackage {
  const release = record(value);
  const tag = typeof release.tag_name === 'string' ? /^v((?:0|[1-9]\d*)\.(?:0|[1-9]\d*)\.(?:0|[1-9]\d*))$/.exec(release.tag_name) : null;
  if (!tag || release.draft === true || release.prerelease === true) throw new UpdateError(updatesTexts.invalidRelease);
  const version = tag[1];
  const name = packageName(version, platform);
  const asset = record(Array.isArray(release.assets) ? release.assets.find((item) => record(item).name === name) : undefined);
  if (!name || !asset.name) throw new UpdateError(updatesTexts.packageMissing);
  const digest = typeof asset.digest === 'string' ? /^sha256:([a-f0-9]{64})$/.exec(asset.digest) : null;
  const url = `https://github.com/${RELEASE_REPOSITORY}/releases/download/v${version}/${name}`;
  const page = `https://github.com/${RELEASE_REPOSITORY}/releases/tag/v${version}`;
  if (!digest || !Number.isSafeInteger(asset.size) || (asset.size as number) <= 0 || asset.browser_download_url !== url)
    throw new UpdateError(updatesTexts.invalidRelease);
  return { version, page, name, size: asset.size as number, sha256: digest[1], url };
}

export class AppUpdates {
  private state: UpdateView;
  private found?: UpdatePackage;
  private file?: string;
  private busy = false;

  constructor(private readonly options: UpdateOptions) {
    this.state = { status: 'idle', currentVersion: options.currentVersion };
  }

  view(): UpdateView {
    return { ...this.state };
  }

  private set(patch: Omit<UpdateView, 'currentVersion'>): UpdateView {
    const release = this.found ? { version: this.found.version, releaseUrl: this.found.page, installable: this.installable() } : {};
    this.state = { currentVersion: this.options.currentVersion, ...release, ...patch };
    return this.view();
  }

  private installable(): boolean {
    return this.options.platform === 'win32' || (this.options.platform === 'linux' && !!this.options.appImage);
  }

  /** Одна операция за раз: повторный клик во время скачивания возвращает текущее состояние. */
  private async exclusive(action: () => Promise<UpdateView>, failure: string): Promise<UpdateView> {
    if (this.busy) return this.view();
    this.busy = true;
    try {
      return await action();
    } catch (error) {
      return this.set({ status: 'error', message: error instanceof UpdateError ? error.message : failure });
    } finally {
      this.busy = false;
    }
  }

  check(): Promise<UpdateView> {
    return this.exclusive(async () => {
      this.found = undefined;
      this.file = undefined;
      const response = await (this.options.fetch ?? fetch)(LATEST_URL, {
        headers: { accept: 'application/vnd.github+json' },
        signal: AbortSignal.timeout(20_000)
      });
      if (!response.ok) throw new UpdateError(updatesTexts.checkFailed);
      const found = releasePackage(await response.json(), this.options.platform);
      if (!newer(found.version, this.options.currentVersion)) return this.set({ status: 'current', message: updatesTexts.current });
      this.found = found;
      return this.set({ status: 'available', message: updatesTexts.available({ version: found.version }) });
    }, updatesTexts.checkFailed);
  }

  download(): Promise<UpdateView> {
    return this.exclusive(async () => {
      const found = this.found;
      if (!found) throw new UpdateError(updatesTexts.checkFirst);
      this.file = undefined;
      // Прежние пакеты занимают сотни мегабайт: в папке хранится только последний скачанный.
      await rm(this.options.directory, { recursive: true, force: true });
      await mkdir(this.options.directory, { recursive: true });
      const file = join(this.options.directory, found.name);
      const partial = `${file}.part`;
      this.set({ status: 'downloading', progress: 0 });
      try {
        const response = await (this.options.fetch ?? fetch)(found.url, { signal: AbortSignal.timeout(30 * 60_000) });
        if (!response.ok || !response.body) throw new UpdateError(updatesTexts.downloadFailed);
        const hash = createHash('sha256');
        const handle = await open(partial, 'wx');
        let size = 0;
        try {
          const reader = response.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            size += value.length;
            if (size > found.size) {
              await reader.cancel();
              throw new UpdateError(updatesTexts.hashMismatch);
            }
            hash.update(value);
            await handle.write(value);
            this.state.progress = size / found.size;
          }
        } finally {
          await handle.close();
        }
        if (size !== found.size || hash.digest('hex') !== found.sha256) throw new UpdateError(updatesTexts.hashMismatch);
        await rename(partial, file);
      } catch (error) {
        await rm(partial, { force: true });
        throw error instanceof UpdateError ? error : new UpdateError(updatesTexts.downloadFailed);
      }
      this.file = file;
      return this.set({
        status: 'ready',
        message: `${updatesTexts.ready({ version: found.version })}${this.installable() ? '' : ` ${updatesTexts.readyManual}`}`
      });
    }, updatesTexts.downloadFailed);
  }

  install(): Promise<UpdateView> {
    return this.exclusive(async () => {
      const file = this.file;
      if (!file || !this.found) throw new UpdateError(updatesTexts.checkFirst);
      if (this.options.platform === 'win32') {
        // Установщик NSIS сам заменит приложение в профиле пользователя и запустит новую версию.
        this.options.launch(file);
        this.options.quit();
        return this.view();
      }
      const appImage = this.options.platform === 'linux' ? this.options.appImage : undefined;
      if (!appImage) {
        this.options.reveal(file);
        return this.view();
      }
      // Копия рядом и rename заменяют файл атомарно; запущенный процесс продолжает работать со старым inode.
      const replacement = `${appImage}.update`;
      try {
        await copyFile(file, replacement);
        await chmod(replacement, 0o755);
        await rename(replacement, appImage);
      } catch {
        await rm(replacement, { force: true });
        throw new UpdateError(updatesTexts.installFailed);
      }
      this.options.relaunch(appImage);
      this.options.quit();
      return this.view();
    }, updatesTexts.installFailed);
  }
}
