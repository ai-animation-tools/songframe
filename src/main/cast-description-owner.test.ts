/** Общее описание проверяется на двух документах; проекция не меняет выбор изображений и не пишет при чтении. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { CastFile, SourceManifest } from '@shared/types';
import { castFromSources, loadDefaults, readCast, viewCast, writeCast } from './cast';
import { planCastDescriptions } from './cast-description-owner';
import * as localFiles from './local-files';

let project: string;
let manifest: SourceManifest;
let cast: CastFile;
const bytes = (name: string): Buffer => readFileSync(join(project, name));
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'cast-description-'));
  mkdirSync(join(project, 'plan'));
  mkdirSync(join(project, 'source/heroes'), { recursive: true });
  for (const file of ['full.png', 'face.png']) writeFileSync(join(project, 'source/heroes', file), file);
  writeFileSync(join(project, 'source/heroes/full.prompt.txt'), 'Точный промпт\r\n');
  manifest = {
    schema_version: 1,
    kinds: [],
    track: null,
    lyrics: null,
    idea: null,
    cover: null,
    updated_at: 'прежде',
    references: [
      {
        id: 'hero',
        kind: 'character',
        name: 'Герой',
        short_name: 'Герой',
        description: 'Общее описание',
        prompt: 'heroes/full.prompt.txt',
        files: ['full.png', 'face.png'].map((name) => ({
          path: `heroes/${name}`,
          sha256: name,
          bytes: 10,
          view: 'front',
          note: name
        }))
      }
    ]
  };
  cast = {
    schema_version: 1,
    properties: {},
    entities: [
      {
        id: 'hero',
        kind: 'character',
        name: 'Герой',
        short_name: 'Герой',
        role: 'Роль',
        appearance: 'Старое независимое описание',
        images: ['heroes/face.png'],
        initial_state: { position: 'у ворот' }
      },
      { id: 'world', kind: 'world', name: 'Мир', short_name: 'Мир', role: '', appearance: '  Собственный мир\n', images: [], initial_state: {} }
    ]
  };
  writeFileSync(join(project, 'source/manifest.json'), JSON.stringify(manifest));
  writeFileSync(join(project, 'plan/cast.json'), JSON.stringify(cast));
});
afterEach(() => {
  vi.restoreAllMocks();
  rmSync(project, { recursive: true, force: true });
});

it('читает canonical описание, сообщает о дрейфе и не изменяет файлы или unbound мир', () => {
  const before = [bytes('source/manifest.json'), bytes('plan/cast.json')];
  const current = readCast(project) as CastFile;
  expect(current.entities[0]).toMatchObject({ appearance: 'Общее описание', images: ['heroes/face.png'], role: 'Роль' });
  expect(current.entities[1].appearance).toBe('  Собственный мир\n');
  expect(viewCast(project, null).problems.join(' ')).toContain('показано общее описание из исходников');
  expect([bytes('source/manifest.json'), bytes('plan/cast.json')]).toEqual(before);
});
it('пустое canonical описание тоже проецируется, без fallback к прежнему appearance', () => {
  manifest.references[0].description = '';
  expect(planCastDescriptions(cast, manifest).cast.entities[0].appearance).toBe('');
  expect(cast.entities[0].appearance).toBe('Старое независимое описание');
});
it('явное сохранение кастинга меняет то же описание, сохраняя metadata, файлы и промпт', () => {
  const before = [bytes('source/heroes/full.png'), bytes('source/heroes/face.png'), bytes('source/heroes/full.prompt.txt')];
  const current = readCast(project) as CastFile;
  current.entities[0].appearance = '  Изменено из кастинга\n';
  const saved = writeCast(project, current, null);
  const result = JSON.parse(bytes('source/manifest.json').toString()) as SourceManifest;
  expect(result.references[0]).toEqual({ ...manifest.references[0], description: '  Изменено из кастинга\n' });
  expect(saved.entities[0].appearance).toBe(result.references[0].description);
  expect(saved.entities[0].images).toEqual(['heroes/face.png']);
  expect([bytes('source/heroes/full.png'), bytes('source/heroes/face.png'), bytes('source/heroes/full.prompt.txt')]).toEqual(before);
});
it('сбой второй записи откатывает точные байты source и cast', () => {
  const before = [bytes('source/manifest.json'), bytes('plan/cast.json')];
  const original = localFiles.writeAtomicBytes;
  let fail = true;
  vi.spyOn(localFiles, 'writeAtomicBytes').mockImplementation((path, data, mode) => {
    original(path, data, mode);
    if (fail && path === join(project, 'plan/cast.json')) {
      fail = false;
      throw new Error('Сбой после записи проекции');
    }
  });
  const current = readCast(project) as CastFile;
  current.entities[0].appearance = 'Новое описание';
  expect(() => writeCast(project, current, null)).toThrow('Сбой после записи проекции');
  expect([bytes('source/manifest.json'), bytes('plan/cast.json')]).toEqual(before);
});
it.each([{ selected: ['heroes/face.png', 'heroes/full.png'] }, { selected: ['heroes/face.png'] }, { selected: [] }])(
  'дополнение сохраняет точный выбор и порядок $selected',
  ({ selected }) => {
    const existing = structuredClone(cast);
    existing.entities[0].images = selected;
    const result = castFromSources(manifest, existing, loadDefaults(null));
    expect(result.entities.find((entity) => entity.id === 'hero')!.images).toEqual(selected);
    expect(result.entities.find((entity) => entity.id === 'hero')!.appearance).toBe('Общее описание');
  }
);
it('повреждённый manifest не превращает связанную сущность в unbound', () => {
  const before = bytes('plan/cast.json');
  writeFileSync(join(project, 'source/manifest.json'), 'Повреждено');
  expect(readCast(project)).toBe(false);
  expect(() => writeCast(project, cast, null)).toThrow();
  expect(bytes('plan/cast.json')).toEqual(before);
});
