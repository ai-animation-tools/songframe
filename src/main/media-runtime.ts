/** Пути медиакомплекта вычисляются относительно runtime целевой ОС, без привязки к checkout сборщика. */
import { environmentTexts } from '@shared/texts/environment';
import { accessSync, constants, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import type { PythonOptions } from './python-runtime';

export const MODEL_FILES = ['config.json', 'model.bin', 'tokenizer.json'];

/** Каталог данных пользователя переживает обновление приложения; путь можно явно переопределить. */
export function modelDirectory(options: PythonOptions, model?: string): string {
  const env = options.env ?? process.env;
  if (!model && env.SONGFRAME_MODEL_DIR) return env.SONGFRAME_MODEL_DIR;
  const data =
    (options.platform ?? process.platform) === 'win32'
      ? env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
      : env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  return join(data, 'songframe', 'models', `faster-whisper-${model ?? 'medium'}`);
}

export function mediaPaths(options: PythonOptions): { binDir: string; modelDir: string; ffmpeg: string; ffprobe: string } | null {
  const platform = options.platform ?? process.platform;
  if (platform !== 'linux' && platform !== 'win32') return null;
  const root = options.packaged
    ? join(options.resourcesPath ?? '', 'runtime')
    : join(options.toolsRoot ?? process.cwd(), 'build/runtime', `${platform}-${options.arch ?? process.arch}`);
  if (!options.packaged && !existsSync(join(root, 'media-manifest.json'))) return null;
  const binDir = join(root, 'bin');
  // Прямые вызовы из Node требуют полного имени .exe; PATH-поиск Python остаётся доступен вложенным инструментам.
  const suffix = platform === 'win32' ? '.exe' : '';
  return { binDir, modelDir: modelDirectory(options), ffmpeg: join(binDir, `ffmpeg${suffix}`), ffprobe: join(binDir, `ffprobe${suffix}`) };
}

/** Быстрая проверка наличия; большие хеши проверяются при подготовке и упаковке. */
export function missingModelFiles(path: string): string[] {
  const missing = (name: string): boolean => {
    try {
      const file = statSync(join(path, name));
      return !file.isFile() || file.size === 0;
    } catch {
      return true;
    }
  };
  const files = MODEL_FILES.filter(missing);
  // Medium использует txt, large-v3 и turbo — json; обе разновидности поддерживаются CTranslate2.
  // eslint-disable-next-line no-restricted-syntax -- Это составное имя ожидаемых файлов модели; формат результата используют проверки установки.
  if (missing('vocabulary.json') && missing('vocabulary.txt')) files.push('vocabulary.json или vocabulary.txt');
  return files;
}

export function requireMediaBinaries(options: PythonOptions): void {
  if (!options.packaged) return;
  const media = mediaPaths(options);
  if (!media) return;
  for (const name of ['ffmpeg', 'ffprobe'] as const) {
    try {
      accessSync(media[name], constants.X_OK);
    } catch {
      throw new Error(environmentTexts.main.bundledMediaUnavailable({ name, binDir: media.binDir }));
    }
  }
}
