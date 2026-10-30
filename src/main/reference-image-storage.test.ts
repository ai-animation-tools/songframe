/** Приёмка референса публикует копию в исходники; архивные оригиналы и прежний выбор остаются целыми. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CastEntity, CastFile, SourceManifest, SourcesInput } from '@shared/types';
import { DEFAULT_SOURCE_KINDS } from '@shared/types';
import { readCast, writeCast } from './cast';
import type * as CastModule from './cast';
import { attachReferenceImage, saveSourcesWithCastImages } from './reference-image-storage';
import { readManifest, sha256File, validateKinds } from './sources';

vi.mock('./cast', async (importOriginal) => {
  const original = await importOriginal<typeof CastModule>();
  return { ...original, writeCast: vi.fn(original.writeCast) };
});

let project: string;
let candidate: { id: string; path: string; prompt: string };
const entity = (id: string, kind = 'character', images: string[] = []): CastEntity => ({
  id,
  kind,
  name: `Имя ${id}`,
  short_name: id,
  role: 'Сохранённая роль',
  appearance: 'Сохранённая внешность',
  images,
  initial_state: { condition: 'Без изменений' }
});
const bytes = (relative: string): Buffer => readFileSync(join(project, relative));
const cast = (): CastFile => readCast(project) as CastFile;

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-reference-storage-'));
  for (const directory of ['source/heroes', 'source/style', 'plan/reference-images/session']) mkdirSync(join(project, directory), { recursive: true });
  writeFileSync(join(project, 'source/heroes/oleg.png'), 'Исходный полный вид');
  writeFileSync(join(project, 'source/heroes/oleg-face.png'), 'Исходное лицо');
  writeFileSync(join(project, 'source/heroes/oleg.prompt.txt'), 'Общий промпт\r\n');
  writeFileSync(join(project, 'source/heroes/oleg-face.png.prompt.txt'), 'Точный промпт лица\r\n');
  writeFileSync(join(project, 'source/text.md'), '[Куплет]\nОдна строка песни\n');
  const file = (path: string) => ({ path, sha256: sha256File(join(project, 'source', path)), bytes: bytes(`source/${path}`).length });
  const manifest: SourceManifest = {
    schema_version: 1,
    kinds: DEFAULT_SOURCE_KINDS.map((kind) => ({ ...kind })),
    track: { path: 'track.mp3', sha256: 'track', bytes: 1, original_name: 'track.mp3', duration_seconds: 10 },
    lyrics: { ...file('text.md'), lines: 1, sections: ['Куплет'] },
    idea: { path: 'description.md', sha256: 'idea', bytes: 1 },
    cover: null,
    references: [
      {
        id: 'oleg',
        kind: 'character',
        name: 'Олег',
        short_name: 'Олег',
        description: 'Описание исходника',
        prompt: 'heroes/oleg.prompt.txt',
        files: [
          { ...file('heroes/oleg.png'), view: 'full', note: 'Старый вид' },
          { ...file('heroes/oleg-face.png'), view: 'face', note: 'Лицо', prompt: 'heroes/oleg-face.png.prompt.txt' }
        ]
      }
    ],
    updated_at: '2026-01-01T00:00:00Z'
  };
  writeFileSync(join(project, 'source/manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
  writeFileSync(
    join(project, 'plan/cast.json'),
    JSON.stringify({
      schema_version: 1,
      properties: {},
      entities: [entity('world', 'world'), entity('oleg', 'character', ['heroes/oleg-face.png']), entity('pavel')]
    })
  );
  candidate = { id: 'session', path: join(project, 'plan/reference-images/session/original.png'), prompt: 'Новый ракурс «&»\r\nТочный текст' };
  const original = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(original);
  original.writeUInt32BE(1200, 16);
  original.writeUInt32BE(800, 20);
  writeFileSync(candidate.path, original);
  vi.mocked(writeCast).mockClear();
});
afterEach(() => {
  vi.mocked(writeCast).mockReset();
  rmSync(project, { recursive: true, force: true });
});

// Сбой записи моделируется после реальной записи, чтобы проверить восстановление обоих документов, а не одного manifest.
async function restoreCastWriter(): Promise<void> {
  const actual = await vi.importActual<typeof CastModule>('./cast');
  vi.mocked(writeCast).mockImplementation(actual.writeCast);
}

function input(): SourcesInput {
  const manifest = readManifest(project)!;
  return {
    track: null,
    lyrics: null,
    idea: null,
    cover: null,
    references: manifest.references.map((ref) => ({
      ...ref,
      prompt: ref.prompt ? readFileSync(join(project, 'source', ref.prompt), 'utf8') : '',
      files: ref.files.map((file) => ({ existingPath: file.path, view: file.view, note: file.note }))
    }))
  };
}

describe('Публикация референса', () => {
  it('добавляет вид именно сохранённой сущности и сохраняет старые изображения, промпты и основной выбор', async () => {
    await restoreCastWriter();
    const oldReference = structuredClone(readManifest(project)!.references[0]);
    const oldCast = cast();
    const archivedOriginal = readFileSync(candidate.path);
    const originals = ['source/heroes/oleg.png', 'source/heroes/oleg-face.png', 'source/heroes/oleg.prompt.txt', 'source/heroes/oleg-face.png.prompt.txt'];
    const before = originals.map(bytes);
    attachReferenceImage(project, 'oleg', candidate, null);
    const relative = 'heroes/oleg-generated-session.png';
    const saved = readManifest(project)!.references[0];
    expect(saved).toMatchObject({
      ...oldReference,
      files: [...oldReference.files, expect.objectContaining({ path: relative, prompt: `${relative}.prompt.txt`, view: 'other' })]
    });
    expect(cast().entities.find((item) => item.id === 'oleg')).toEqual({ ...oldCast.entities[1], images: ['heroes/oleg-face.png', relative] });
    expect(cast().entities.find((item) => item.id === 'pavel')).toEqual(oldCast.entities[2]);
    expect(originals.map(bytes)).toEqual(before);
    expect(bytes(`source/${relative}`)).toEqual(readFileSync(candidate.path));
    expect(bytes(`source/${relative}.prompt.txt`).toString()).toBe(candidate.prompt);
    expect(readFileSync(candidate.path)).toEqual(archivedOriginal);
  });

  it.each([
    ['pavel', 'character', 'heroes'],
    ['world', 'style', 'style']
  ])('создаёт недостающий референс %s без изменения типа сущности', async (id, kind, directory) => {
    await restoreCastWriter();
    attachReferenceImage(project, id, candidate, null);
    const path = `${directory}/${id}-generated-session.png`;
    expect(readManifest(project)!.references.find((ref) => ref.id === id)).toMatchObject({
      id,
      kind,
      files: [expect.objectContaining({ path, view: 'full' })]
    });
    expect(cast().entities.find((item) => item.id === id)).toMatchObject({ kind: id === 'world' ? 'world' : 'character', images: [path] });
  });

  it.each([
    ['pavel', 'heroes', 'heroes', 'heroes-3'],
    ['world', 'world', 'style', 'style-3']
  ])('выбирает свободную папку для нового типа сущности %s и сохраняет чужие файлы', async (id, entityKind, occupied, expectedDirectory) => {
    await restoreCastWriter();
    const manifest = readManifest(project)!;
    if (occupied === 'style') manifest.kinds = manifest.kinds!.filter((kind) => kind.id !== 'style');
    manifest.kinds!.push({ id: 'reserved', label: 'Занятая папка', dir: `${occupied}-2` });
    if (occupied === 'style') manifest.kinds!.push({ id: 'custom', label: 'Другой тип', dir: occupied });
    writeFileSync(join(project, 'source/manifest.json'), JSON.stringify(manifest));
    const current = cast();
    current.entities.find((item) => item.id === id)!.kind = entityKind;
    writeFileSync(join(project, 'plan/cast.json'), JSON.stringify(current));
    const existingFile = join(project, 'source', occupied, 'protected.png');
    writeFileSync(existingFile, 'Прежнее изображение другого типа');
    const protectedBytes = readFileSync(existingFile);
    const original = readFileSync(candidate.path);

    attachReferenceImage(project, id, candidate, null);

    const result = readManifest(project)!;
    const kindId = entityKind === 'world' ? 'style' : entityKind;
    expect(result.kinds!.find((kind) => kind.id === kindId)?.dir).toBe(expectedDirectory);
    expect(validateKinds(result.kinds!)).toEqual([]);
    const image = `${expectedDirectory}/${id}-generated-session.png`;
    expect(result.references.find((ref) => ref.id === id)?.files[0].path).toBe(image);
    expect(cast().entities.find((item) => item.id === id)!.images).toContain(image);
    expect(bytes(`source/${image}`)).toEqual(original);
    expect(readFileSync(existingFile)).toEqual(protectedBytes);
    const savedManifest = bytes('source/manifest.json');
    const savedCast = bytes('plan/cast.json');

    attachReferenceImage(project, id, candidate, null);

    expect(bytes('source/manifest.json')).toEqual(savedManifest);
    expect(bytes('plan/cast.json')).toEqual(savedCast);
    expect(readFileSync(candidate.path)).toEqual(original);
    expect(readFileSync(existingFile)).toEqual(protectedBytes);
  });

  it('отвергает уже повреждённые типы до записи файлов и документов', async () => {
    await restoreCastWriter();
    const manifest = readManifest(project)!;
    manifest.kinds!.push({ id: 'duplicate', label: 'Другой тип', dir: 'heroes' });
    writeFileSync(join(project, 'source/manifest.json'), JSON.stringify(manifest));
    const beforeManifest = bytes('source/manifest.json');
    const beforeCast = bytes('plan/cast.json');
    const filenames = readdirSync(join(project, 'source/heroes')).sort();

    expect(() => attachReferenceImage(project, 'pavel', candidate, null)).toThrow('Папка повторяется');

    expect(bytes('source/manifest.json')).toEqual(beforeManifest);
    expect(bytes('plan/cast.json')).toEqual(beforeCast);
    expect(readdirSync(join(project, 'source/heroes')).sort()).toEqual(filenames);
    expect(writeCast).not.toHaveBeenCalled();
  });

  it('повторная приёмка того же результата не меняет документы, файлы и промпт', async () => {
    await restoreCastWriter();
    attachReferenceImage(project, 'oleg', candidate, null);
    const manifest = bytes('source/manifest.json');
    const savedCast = bytes('plan/cast.json');
    const filenames = readdirSync(join(project, 'source/heroes')).sort();
    attachReferenceImage(project, 'oleg', { ...candidate, prompt: 'Подмена промпта при повторе' }, null);
    expect(bytes('source/manifest.json')).toEqual(manifest);
    expect(bytes('plan/cast.json')).toEqual(savedCast);
    expect(readdirSync(join(project, 'source/heroes')).sort()).toEqual(filenames);
    expect(bytes('source/heroes/oleg-generated-session.png.prompt.txt').toString()).toBe(candidate.prompt);
    expect(writeCast).toHaveBeenCalledTimes(1);
  });

  it('после частичной записи cast восстанавливает точные байты обоих документов и убирает только новые файлы', async () => {
    const actual = await vi.importActual<typeof CastModule>('./cast');
    vi.mocked(writeCast).mockImplementation((...args) => {
      actual.writeCast(...args);
      throw new Error('Сбой после записи кастинга');
    });
    const manifest = bytes('source/manifest.json');
    const savedCast = bytes('plan/cast.json');
    const filenames = readdirSync(join(project, 'source/heroes')).sort();
    expect(() => attachReferenceImage(project, 'oleg', candidate, null)).toThrow('Сбой после записи');
    expect(bytes('source/manifest.json')).toEqual(manifest);
    expect(bytes('plan/cast.json')).toEqual(savedCast);
    expect(readdirSync(join(project, 'source/heroes')).sort()).toEqual(filenames);
    expect(existsSync(candidate.path)).toBe(true);
  });

  it('не изменяет проект при неизвестной сущности', () => {
    const manifest = bytes('source/manifest.json');
    const savedCast = bytes('plan/cast.json');
    expect(() => attachReferenceImage(project, 'missing', candidate, null)).toThrow();
    expect(bytes('source/manifest.json')).toEqual(manifest);
    expect(bytes('plan/cast.json')).toEqual(savedCast);
    expect(writeCast).not.toHaveBeenCalled();
  });
});

describe('Синхронизация новых изображений формы с кастингом', () => {
  it('добавляет новый вид в cast, сохраняя выбор, порядок и ранее исключённый вид', async () => {
    await restoreCastWriter();
    const next = input();
    next.references[0].files.push({ sourcePath: candidate.path, view: 'back', note: 'Сзади', prompt: candidate.prompt });
    const saved = saveSourcesWithCastImages(project, next, null);
    const added = saved.references[0].files[2];
    expect(cast().entities.find((item) => item.id === 'oleg')!.images).toEqual(['heroes/oleg-face.png', added.path]);
    expect(cast().entities.find((item) => item.id === 'oleg')!.images).not.toContain('heroes/oleg.png');
    expect(bytes('source/heroes/oleg-face.png.prompt.txt').toString()).toBe('Точный промпт лица\r\n');
    expect(bytes(`source/${added.prompt}`).toString()).toBe('Новый ракурс «&»\nТочный текст\n');
  });

  it('добавляет новый вид в cast при повторном использовании имени удалённого невыбранного изображения', async () => {
    await restoreCastWriter();
    const manifest = readManifest(project)!;
    manifest.references[0].files[1].path = 'heroes/oleg-2.png';
    writeFileSync(join(project, 'source/heroes/oleg-2.png'), bytes('source/heroes/oleg-face.png'));
    rmSync(join(project, 'source/heroes/oleg-face.png'));
    writeFileSync(join(project, 'source/manifest.json'), JSON.stringify(manifest));
    const current = cast();
    current.entities.find((item) => item.id === 'oleg')!.images = ['heroes/oleg.png'];
    writeFileSync(join(project, 'plan/cast.json'), JSON.stringify(current));
    const original = readFileSync(candidate.path);
    const oldFull = bytes('source/heroes/oleg.png');
    const next = input();
    next.references[0].files = [next.references[0].files[0], { sourcePath: candidate.path, view: 'back', note: 'Новый вид', prompt: candidate.prompt }];

    const saved = saveSourcesWithCastImages(project, next, null);

    expect(saved.references[0].files[1].path).toBe('heroes/oleg-2.png');
    expect(cast().entities.find((item) => item.id === 'oleg')!.images).toEqual(['heroes/oleg.png', 'heroes/oleg-2.png']);
    expect(bytes('source/heroes/oleg-2.png')).toEqual(original);
    expect(bytes('source/heroes/oleg.png')).toEqual(oldFull);
    expect(readFileSync(candidate.path)).toEqual(original);
  });

  it('ошибка записи cast откатывает сохранение новых исходников и прежних промптов', async () => {
    const actual = await vi.importActual<typeof CastModule>('./cast');
    vi.mocked(writeCast).mockImplementation((...args) => {
      actual.writeCast(...args);
      throw new Error('Сбой после записи кастинга');
    });
    const next = input();
    next.references[0].files.push({ sourcePath: candidate.path, view: 'back', note: 'Сзади', prompt: candidate.prompt });
    next.references[0].files[1].prompt = 'Изменённый промпт старого лица';
    const manifest = bytes('source/manifest.json');
    const savedCast = bytes('plan/cast.json');
    const oldPrompt = bytes('source/heroes/oleg-face.png.prompt.txt');
    const oldImages = [bytes('source/heroes/oleg.png'), bytes('source/heroes/oleg-face.png')];
    const filenames = readdirSync(join(project, 'source/heroes')).sort();
    expect(() => saveSourcesWithCastImages(project, next, null)).toThrow('Сбой после записи');
    expect(bytes('source/manifest.json')).toEqual(manifest);
    expect(bytes('plan/cast.json')).toEqual(savedCast);
    expect(bytes('source/heroes/oleg-face.png.prompt.txt')).toEqual(oldPrompt);
    expect([bytes('source/heroes/oleg.png'), bytes('source/heroes/oleg-face.png')]).toEqual(oldImages);
    expect(readdirSync(join(project, 'source/heroes')).sort()).toEqual(filenames);
    expect(existsSync(candidate.path)).toBe(true);
  });

  it('запрещает удаление используемого cast изображения до изменения исходников и документов', async () => {
    await restoreCastWriter();
    const next = input();
    next.references[0].files = [{ sourcePath: candidate.path, view: 'back', note: 'Замена' }];
    const manifest = bytes('source/manifest.json');
    const savedCast = bytes('plan/cast.json');
    const oldFull = bytes('source/heroes/oleg.png');
    const oldFace = bytes('source/heroes/oleg-face.png');
    const filenames = readdirSync(join(project, 'source/heroes')).sort();
    expect(() => saveSourcesWithCastImages(project, next, null)).toThrow();
    expect(bytes('source/manifest.json')).toEqual(manifest);
    expect(bytes('plan/cast.json')).toEqual(savedCast);
    expect(bytes('source/heroes/oleg.png')).toEqual(oldFull);
    expect(bytes('source/heroes/oleg-face.png')).toEqual(oldFace);
    expect(readdirSync(join(project, 'source/heroes')).sort()).toEqual(filenames);
    expect(writeCast).not.toHaveBeenCalled();
  });

  it('обычное сохранение исходников не сбрасывает вручную выбранные изображения кастинга', async () => {
    await restoreCastWriter();
    const savedCast = bytes('plan/cast.json');
    saveSourcesWithCastImages(project, input(), null);
    expect(bytes('plan/cast.json')).toEqual(savedCast);
    expect(writeCast).not.toHaveBeenCalled();
  });
});
