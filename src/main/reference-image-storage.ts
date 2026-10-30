/** Референсы и кастинг делят один файл в source; приёмка добавляет вид, сохраняя прежние байты. */
import { constants, copyFileSync, cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, extname, join } from 'node:path';
import { mkdirSync } from 'node:fs';
import type { SourceManifest, SourcesInput } from '@shared/types';
import { DEFAULT_SOURCE_KINDS } from '@shared/types';
import { referenceImageTexts as texts } from '@shared/texts/reference-images';
import { normalizeCast, readCast, writeCast } from './cast';
import { imageExtensionMatches } from './keyframe-images';
import { writeAtomicBytes, writeLocalJson } from './local-files';
import { readManifest, saveSources, sha256File, validateKinds } from './sources';

/** Добавляются только новые виды исходников: сохранённый выбор остальных изображений кастинга остаётся прежним. */
export function saveSourcesWithCastImages(project: string, input: SourcesInput, toolsRoot: string | null, ffprobe?: string): SourceManifest {
  const previous = readManifest(project);
  const cast = readCast(project);
  if (cast === false) throw new Error(texts.castInvalid);
  if (cast) {
    normalizeCast(cast, toolsRoot);
    const known = new Set(previous?.references.flatMap((ref) => ref.files.map((file) => file.path)) ?? []);
    const kept = new Set(input.references.flatMap((ref) => ref.files.flatMap((file) => (file.existingPath ? [file.existingPath] : []))));
    // Сначала снимают использование в кастинге: сохранение исходников не должно оставлять битые ссылки.
    if (cast.entities.some((entity) => entity.images.some((path) => known.has(path) && !kept.has(path)))) throw new Error(texts.imageInUse);
  }
  // Резерв нужен только при совместной публикации нового вида в source и cast.
  // Reflink по возможности сохраняет большой трек без полного физического копирования.
  const synchronizing = !!cast?.entities.some((entity) => input.references.some((ref) => ref.id === entity.id && ref.files.some((file) => file.sourcePath)));
  const backup = synchronizing ? mkdtempSync(join(tmpdir(), 'songframe-source-save-')) : null;
  const source = join(project, 'source');
  const castPath = join(project, 'plan/cast.json');
  const oldCast = backup ? readFileSync(castPath) : null;
  let copied = false;
  let keepBackup = false;
  try {
    if (backup) {
      cpSync(source, join(backup, 'source'), { recursive: true, mode: constants.COPYFILE_FICLONE });
      copied = true;
    }
    const manifest = saveSources(project, input, ffprobe);
    if (!cast) return manifest;
    let changed = false;
    for (const entity of cast.entities) {
      const old = new Set(previous?.references.find((ref) => ref.id === entity.id)?.files.map((file) => file.path) ?? []);
      const incoming = input.references.find((ref) => ref.id === entity.id);
      // Новый вид может занять имя удалённого невыбранного файла; его определяет ввод, а не только путь результата.
      const added =
        manifest.references.find((ref) => ref.id === entity.id)?.files.filter((file, index) => !!incoming?.files[index]?.sourcePath || !old.has(file.path)) ??
        [];
      for (const file of added)
        if (!entity.images.includes(file.path)) {
          entity.images.push(file.path);
          changed = true;
        }
    }
    if (changed) writeCast(project, cast, toolsRoot);
    return manifest;
  } catch (error) {
    if (backup && copied && oldCast) {
      try {
        rmSync(source, { recursive: true, force: true });
        cpSync(join(backup, 'source'), source, { recursive: true, mode: constants.COPYFILE_FICLONE });
        writeAtomicBytes(castPath, oldCast);
      } catch (restoreError) {
        keepBackup = true;
        throw new Error(texts.restoreFailed({ path: backup, reason: String(restoreError) }), { cause: restoreError });
      }
    }
    throw error;
  } finally {
    if (backup && !keepBackup) rmSync(backup, { recursive: true, force: true });
  }
}

/** Узкая публикация принятого кандидата: два документа с откатом при ошибке, оригинал архива не изменяется. */
export function attachReferenceImage(project: string, entityId: string, result: { id: string; path: string; prompt: string }, toolsRoot: string | null): void {
  const manifest = readManifest(project);
  if (!manifest) throw new Error(texts.manifestMissing);
  const rawCast = readCast(project);
  if (!rawCast) throw new Error(texts.castInvalid);
  const cast = normalizeCast(rawCast, toolsRoot);
  const entity = cast.entities.find((item) => item.id === entityId);
  if (!entity) throw new Error(texts.entityMissing);
  if (!imageExtensionMatches(result.path)) throw new Error(texts.imageInvalid);
  const kinds = manifest.kinds?.length ? manifest.kinds : DEFAULT_SOURCE_KINDS.map((kind) => ({ ...kind }));
  manifest.kinds = kinds;
  let ref = manifest.references.find((item) => item.id === entityId);
  if (!ref) {
    // У world нет собственного типа исходника: общий вид мира хранится среди референсов стиля.
    const kindId = entity.kind === 'world' ? 'style' : entity.kind;
    if (!kinds.some((kind) => kind.id === kindId)) {
      const fallback = DEFAULT_SOURCE_KINDS.find((kind) => kind.id === kindId);
      const base = fallback?.dir ?? kindId;
      let dir = base;
      // Тип кастинга открыт; его код или штатная папка уже могут принадлежать другому типу исходника.
      // Свободный суффикс сохраняет прежние файлы и уникальность kinds[].dir без переименования данных.
      for (let suffix = 2; kinds.some((kind) => kind.dir === dir); suffix++) dir = `${base}-${suffix}`;
      kinds.push(fallback ? { ...fallback, dir } : { id: kindId, label: kindId, dir });
    }
    ref = { id: entity.id, kind: kindId, name: entity.name, short_name: entity.short_name, description: entity.appearance, prompt: null, files: [] };
    manifest.references.push(ref);
  }
  const kindProblems = validateKinds(kinds);
  if (kindProblems.length) throw new Error(kindProblems.join(' '));
  const kind = kinds.find((item) => item.id === ref.kind);
  if (!kind || !/^[a-z][a-z0-9_-]*$/.test(kind.dir)) throw new Error(texts.castInvalid);
  const extension = extname(result.path).toLowerCase();
  const relative = `${kind.dir}/${entity.id}-generated-${result.id}${extension}`;
  const source = join(project, 'source');
  const imagePath = join(source, relative);
  const prompt = `${relative}.prompt.txt`;
  // Повтор приёмки после сбоя renderer не создаёт второе изображение или платную попытку.
  if (ref.files.some((file) => file.path === relative) && entity.images.includes(relative)) return;
  const manifestPath = join(source, 'manifest.json');
  const castPath = join(project, 'plan/cast.json');
  const oldManifest = readFileSync(manifestPath);
  const oldCast = readFileSync(castPath);
  const imageExisted = existsSync(imagePath);
  const promptExisted = existsSync(join(source, prompt));
  try {
    mkdirSync(dirname(imagePath), { recursive: true });
    if (!imageExisted) copyFileSync(result.path, imagePath);
    if (!promptExisted) writeAtomicBytes(join(source, prompt), Buffer.from(result.prompt, 'utf8'));
    if (!ref.files.some((file) => file.path === relative))
      ref.files.push({
        path: relative,
        sha256: sha256File(imagePath),
        bytes: readFileSync(imagePath).length,
        view: ref.files.length ? 'other' : 'full',
        note: '',
        prompt
      });
    if (!entity.images.includes(relative)) entity.images.push(relative);
    manifest.updated_at = new Date().toISOString();
    writeLocalJson(manifestPath, manifest);
    writeCast(project, cast, toolsRoot);
  } catch (error) {
    writeAtomicBytes(manifestPath, oldManifest);
    writeAtomicBytes(castPath, oldCast);
    if (!imageExisted) rmSync(imagePath, { force: true });
    if (!promptExisted) rmSync(join(source, prompt), { force: true });
    throw error;
  }
}
