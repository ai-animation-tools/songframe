/** Контракт медиапоставки: переносимые пути, приоритет bundled-бинарников и явные ошибки. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mediaPaths, missingModelFiles, modelDirectory, MODEL_FILES, requireMediaBinaries } from './media-runtime';
import { pythonEnv } from './python-runtime';
import { probeDuration } from './sources';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-media-'));
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('Медиапоставка Linux и Windows', () => {
  it('переносит бинарники вместе с приложением, сохраняя модель в данных пользователя и внешние CLI в PATH', () => {
    const resourcesPath = join(work, 'Приложение с пробелами');
    const options = {
      packaged: true,
      platform: 'linux' as const,
      resourcesPath,
      toolsRoot: resourcesPath,
      env: { PATH: '/external/bin', XDG_DATA_HOME: join(work, 'данные') }
    };
    const media = mediaPaths(options)!;
    expect(media.binDir).toBe(join(resourcesPath, 'runtime/bin'));
    expect(media.modelDir).toBe(join(work, 'данные/songframe/models/faster-whisper-medium'));
    expect(pythonEnv(options)).toMatchObject({ PATH: `${media.binDir}:/external/bin`, SONGFRAME_MODEL_DIR: media.modelDir });
    expect(pythonEnv({ ...options, env: { PATH: '' } }).PATH).toBe(media.binDir);
  });

  it.skipIf(process.platform !== 'linux')('длительность при импорте использует явный встроенный ffprobe, а не PATH', () => {
    const command = join(work, 'Встроенный ffprobe');
    writeFileSync(command, `#!${process.execPath}\nprocess.stdout.write('12.345\\n');\n`, { mode: 0o755 });
    expect(probeDuration(join(work, 'track.mp3'), command)).toBe(12.345);
  });

  it('не подменяет отсутствующий bundled FFmpeg системным бинарником', () => {
    const options = { packaged: true, platform: 'linux' as const, resourcesPath: work, toolsRoot: work, env: { PATH: '/usr/bin' } };
    expect(() => requireMediaBinaries(options)).toThrow('Встроенный ffmpeg недоступен');
  });

  it('использует Windows EXE из перенесённой поставки и добавляет их каталог в PATH', () => {
    const resourcesPath = join(work, 'Приложение с пробелами');
    const binDir = join(resourcesPath, 'runtime/bin');
    const options = {
      packaged: true,
      platform: 'win32' as const,
      resourcesPath,
      toolsRoot: resourcesPath,
      env: { PATH: 'C:\\external', LOCALAPPDATA: join(work, 'Local') }
    };
    expect(mediaPaths(options)).toMatchObject({ binDir, ffmpeg: join(binDir, 'ffmpeg.exe'), ffprobe: join(binDir, 'ffprobe.exe') });
    expect(pythonEnv(options)).toMatchObject({ PATH: `${binDir};C:\\external`, SONGFRAME_BIN_DIR: binDir });
    expect(() => requireMediaBinaries(options)).toThrow('Встроенный ffmpeg недоступен');
    mkdirSync(binDir, { recursive: true });
    // Имена без .exe не должны маскировать неполную Windows-поставку.
    for (const name of ['ffmpeg', 'ffprobe']) writeFileSync(join(binDir, name), 'fixture', { mode: 0o755 });
    expect(() => requireMediaBinaries(options)).toThrow('Встроенный ffmpeg недоступен');
    writeFileSync(join(binDir, 'ffmpeg.exe'), 'fixture', { mode: 0o755 });
    expect(() => requireMediaBinaries(options)).toThrow('Встроенный ffprobe недоступен');
    writeFileSync(join(binDir, 'ffprobe.exe'), 'fixture', { mode: 0o755 });
    expect(() => requireMediaBinaries(options)).not.toThrow();
  });

  it('подключает подготовленный Windows-медиакомплект при разработке', () => {
    const root = join(work, 'build/runtime/win32-x64');
    mkdirSync(root, { recursive: true });
    writeFileSync(join(root, 'media-manifest.json'), '{}');
    expect(mediaPaths({ toolsRoot: work, platform: 'win32', arch: 'x64' })?.ffprobe).toBe(join(root, 'bin/ffprobe.exe'));
  });

  it('обнаруживает неполную модель без чтения всех весов при пользовательском действии', () => {
    const model = join(work, 'model');
    mkdirSync(model);
    for (const name of [...MODEL_FILES, 'vocabulary.txt']) writeFileSync(join(model, name), 'fixture');
    expect(missingModelFiles(model)).toEqual([]);
    // Large-v3 имеет json-словарь; старый txt не обязателен.
    rmSync(join(model, 'vocabulary.txt'));
    writeFileSync(join(model, 'vocabulary.json'), 'fixture');
    expect(missingModelFiles(model)).toEqual([]);
    writeFileSync(join(model, 'model.bin'), '');
    rmSync(join(model, 'tokenizer.json'));
    expect(missingModelFiles(model)).toEqual(['model.bin', 'tokenizer.json']);
  });

  it('вычисляет Windows-каталог данных без пути сборщика и допускает ручное переопределение', () => {
    const options = { toolsRoot: work, platform: 'win32' as const, env: { LOCALAPPDATA: join(work, 'Local') } };
    expect(modelDirectory(options, 'large-v3')).toBe(join(work, 'Local/songframe/models/faster-whisper-large-v3'));
    expect(modelDirectory({ ...options, env: { SONGFRAME_MODEL_DIR: work } })).toBe(work);
  });

  it('сохраняет обычный dev PATH, пока медиакомплект не подготовлен', () => {
    const options = { toolsRoot: work, platform: 'linux' as const, env: { PATH: '/developer/bin' } };
    expect(mediaPaths(options)).toBeNull();
    expect(pythonEnv(options).PATH).toBe('/developer/bin');
    expect(() => requireMediaBinaries(options)).not.toThrow();
  });
});
