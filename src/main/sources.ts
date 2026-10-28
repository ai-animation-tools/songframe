/**
 * Исходники проекта: трек, текст песни, идея, обложка и референсы в source/ и их опись source/manifest.json.
 * Имена трека и текста фиксированы (track.mp3, text.md, description.md), потому что их читают инструменты.
 */

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { basename, extname, join, resolve } from 'node:path';
import { analyzeLyrics } from '@shared/lyrics';
import {
  DEFAULT_SOURCE_KINDS,
  type ManifestFile,
  type ReferenceFile,
  type ReferenceInput,
  type SourceKind,
  type SourceManifest,
  type SourceReference,
  type SourcesInput,
  type SourcesView
} from '@shared/types';

export const SOURCE_DIR = 'source';
export const MANIFEST_NAME = 'manifest.json';
export const TRACK_NAME = 'track.mp3';
export const LYRICS_NAME = 'text.md';
export const IDEA_NAME = 'description.md';
const SLUG = /^[a-z][a-z0-9_]*$/;
const DIR_SLUG = /^[a-z][a-z0-9_-]*$/;
const RESERVED_KIND = 'world';

/** Типы референсов проекта: из ввода, иначе из манифеста, иначе набор по умолчанию. */
export function resolveKinds(input: SourcesInput | null, previous: SourceManifest | null): SourceKind[] {
  return input?.kinds ?? previous?.kinds ?? DEFAULT_SOURCE_KINDS.map((k) => ({ ...k }));
}

export function validateKinds(kinds: SourceKind[]): string[] {
  const problems: string[] = [];
  const ids = new Set<string>();
  const dirs = new Set<string>();
  for (const kind of kinds) {
    if (!SLUG.test(kind.id)) problems.push(`Код типа «${kind.label || kind.id}»: латиница в нижнем регистре, цифры и подчёркивание.`);
    if (kind.id === RESERVED_KIND) problems.push('Тип world зарезервирован для общих условий сцены.');
    if (!kind.label.trim()) problems.push(`У типа ${kind.id} нет подписи.`);
    if (!DIR_SLUG.test(kind.dir)) problems.push(`Папка типа ${kind.id}: латиница, цифры, дефис и подчёркивание.`);
    if (ids.has(kind.id)) problems.push(`Код типа повторяется: ${kind.id}.`);
    if (dirs.has(kind.dir)) problems.push(`Папка повторяется: ${kind.dir}.`);
    ids.add(kind.id);
    dirs.add(kind.dir);
  }
  return problems;
}
const IMAGE_EXTENSIONS = new Set(['.png', '.jpg', '.jpeg', '.webp']);
const ID_PATTERN = /^[a-z][a-z0-9_]*$/;
export function sha256File(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

function describe(root: string, relative: string): ManifestFile {
  const full = join(root, relative);
  return { path: relative.split('\\').join('/'), sha256: sha256File(full), bytes: statSync(full).size };
}

/** Строки песни: одна строка файла это одна строка песни, части в квадратных скобках, пустые строки разделяют части. */
export function parseLyrics(text: string): { lines: number; sections: string[]; problems: string[] } {
  const { lines, sections, problems } = analyzeLyrics(text);
  return { lines, sections, problems };
}

export function validateReferences(references: ReferenceInput[], kinds: SourceKind[]): string[] {
  const problems: string[] = [];
  const seen = new Set<string>();
  const kindIds = new Set(kinds.map((k) => k.id));
  for (const ref of references) {
    const label = ref.name || ref.id || '(без имени)';
    if (!ID_PATTERN.test(ref.id)) problems.push(`Код референса «${label}»: латиница в нижнем регистре, цифры и подчёркивание, начиная с буквы.`);
    if (seen.has(ref.id)) problems.push(`Код референса повторяется: ${ref.id}.`);
    seen.add(ref.id);
    if (!ref.name.trim()) problems.push(`У референса ${ref.id} нет названия.`);
    if (!kindIds.has(ref.kind)) problems.push(`У референса ${ref.id} неизвестный тип ${ref.kind}: добавьте тип в список типов.`);
    if (ref.files.length === 0) problems.push(`У референса ${ref.id} нет ни одного изображения.`);
    for (const file of ref.files) {
      const source = file.sourcePath ?? file.existingPath;
      if (!source) problems.push(`У референса ${ref.id} файл без пути.`);
      else if (file.sourcePath && !IMAGE_EXTENSIONS.has(extname(file.sourcePath).toLowerCase()))
        problems.push(`Референс ${ref.id}: допустимы PNG, JPG и WebP, получен ${basename(file.sourcePath)}.`);
      else if (file.sourcePath && !existsSync(file.sourcePath)) problems.push(`Референс ${ref.id}: файл не найден: ${file.sourcePath}.`);
    }
  }
  return problems;
}

/** В поставке используется вычисленный путь встроенного ffprobe, в dev допустим PATH. Отсутствие probe не блокирует загрузку. */
export function probeDuration(path: string, command = 'ffprobe'): number | null {
  const result = spawnSync(command, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'default=nw=1:nk=1', path], {
    encoding: 'utf-8',
    windowsHide: true
  });
  if (result.status !== 0) return null;
  const value = Number.parseFloat(result.stdout.trim());
  return Number.isFinite(value) ? Math.round(value * 1000) / 1000 : null;
}

export function readManifest(project: string): SourceManifest | null {
  try {
    const data = JSON.parse(readFileSync(join(project, SOURCE_DIR, MANIFEST_NAME), 'utf-8')) as SourceManifest;
    return data && data.schema_version === 1 ? data : null;
  } catch {
    return null;
  }
}

function readText(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf-8') : '';
}

export function viewSources(project: string): SourcesView {
  const manifest = readManifest(project);
  const source = join(project, SOURCE_DIR);
  const problems: string[] = [];
  const referenceFilePaths: Record<string, string> = {};
  if (manifest) {
    const check = (file: ManifestFile | null, label: string): void => {
      if (file && !existsSync(join(source, file.path))) problems.push(`${label}: файл ${file.path} отсутствует.`);
    };
    check(manifest.track, 'Трек');
    check(manifest.lyrics, 'Текст песни');
    check(manifest.idea, 'Идея');
    check(manifest.cover, 'Обложка');
    for (const ref of manifest.references) {
      for (const file of ref.files) {
        check(file, `Референс ${ref.id}`);
        referenceFilePaths[file.path] = join(source, file.path);
      }
    }
  } else if (existsSync(join(source, MANIFEST_NAME))) {
    problems.push('source/manifest.json повреждён или другой версии.');
  }
  return {
    manifest,
    lyricsText: readText(join(source, manifest?.lyrics?.path ?? LYRICS_NAME)),
    ideaText: readText(join(source, manifest?.idea?.path ?? IDEA_NAME)),
    coverPath: manifest?.cover ? join(source, manifest.cover.path) : null,
    referenceFilePaths,
    problems
  };
}

/** Проверяет ввод с учётом уже сохранённого: обязательные части должны быть либо новыми, либо сохранёнными. */
export function validateSources(project: string, input: SourcesInput): string[] {
  const existing = readManifest(project);
  const problems: string[] = [];
  if (!input.track && !existing?.track) problems.push('Трек обязателен.');
  if (input.track) {
    if (!existsSync(input.track.path)) problems.push(`Файл трека не найден: ${input.track.path}`);
    else if (extname(input.track.path).toLowerCase() !== '.mp3') problems.push('Трек должен быть в формате MP3.');
  }
  const textProblem = (value: SourcesInput['lyrics'], saved: unknown, label: string, requiredMessage: string): void => {
    if (!value && !saved) problems.push(requiredMessage);
    if (value && 'path' in value && !existsSync(value.path)) problems.push(`${label}: файл не найден: ${value.path}`);
    if (value && 'text' in value && !value.text.trim()) problems.push(`${label}: пустой текст.`);
  };
  textProblem(input.lyrics, existing?.lyrics, 'Текст песни', 'Текст песни обязателен.');
  textProblem(input.idea, existing?.idea, 'Идея клипа', 'Идея клипа обязательна.');
  const lyricsPath = input.lyrics && 'path' in input.lyrics ? input.lyrics.path : existing?.lyrics ? join(project, SOURCE_DIR, existing.lyrics.path) : null;
  const lyricsText =
    input.lyrics && 'text' in input.lyrics ? input.lyrics.text : lyricsPath && existsSync(lyricsPath) ? readFileSync(lyricsPath, 'utf-8') : null;
  // Тот же разбор применяется к вводу, импорту и уже сохранённому тексту.
  if (lyricsText !== null) problems.push(...parseLyrics(lyricsText).problems);
  if (input.cover && 'path' in input.cover) {
    if (!existsSync(input.cover.path)) problems.push(`Файл обложки не найден: ${input.cover.path}`);
    else if (!IMAGE_EXTENSIONS.has(extname(input.cover.path).toLowerCase())) problems.push('Обложка: допустимы PNG, JPG и WebP.');
  }
  const kinds = resolveKinds(input, existing);
  problems.push(...validateKinds(kinds));
  problems.push(...validateReferences(input.references, kinds));
  return problems;
}

function textFrom(value: { path: string } | { text: string }): string {
  return 'path' in value ? readFileSync(value.path, 'utf-8') : value.text;
}

function normalizeText(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/, '') + '\n';
}

/**
 * Сохраняет исходники и пишет манифест. Новые файлы копируются, прежние остаются; изображения референсов,
 * исчезнувшие из ввода, удаляются только если они перечислены в прежнем манифесте.
 */
export function saveSources(project: string, input: SourcesInput, ffprobe = 'ffprobe'): SourceManifest {
  const problems = validateSources(project, input);
  if (problems.length) throw new Error(problems.join(' '));
  const previous = readManifest(project);
  const kinds = resolveKinds(input, previous);
  const dirOf = new Map(kinds.map((k) => [k.id, k.dir]));
  const source = join(project, SOURCE_DIR);
  mkdirSync(source, { recursive: true });

  let track = previous?.track ?? null;
  if (input.track) {
    copyFileSync(input.track.path, join(source, TRACK_NAME));
    track = { ...describe(source, TRACK_NAME), original_name: basename(input.track.path), duration_seconds: probeDuration(join(source, TRACK_NAME), ffprobe) };
  }
  let lyrics = previous?.lyrics ?? null;
  if (input.lyrics) {
    const text = normalizeText(textFrom(input.lyrics));
    writeFileSync(join(source, LYRICS_NAME), text, 'utf-8');
    const parsed = parseLyrics(text);
    lyrics = { ...describe(source, LYRICS_NAME), lines: parsed.lines, sections: parsed.sections };
  }
  let idea = previous?.idea ?? null;
  if (input.idea) {
    writeFileSync(join(source, IDEA_NAME), normalizeText(textFrom(input.idea)), 'utf-8');
    idea = describe(source, IDEA_NAME);
  }
  let cover = previous?.cover ?? null;
  if (input.cover && 'remove' in input.cover) {
    if (cover) rmSync(join(source, cover.path), { force: true });
    cover = null;
  } else if (input.cover) {
    if (cover) rmSync(join(source, cover.path), { force: true });
    const name = 'cover' + extname(input.cover.path).toLowerCase();
    copyFileSync(input.cover.path, join(source, name));
    cover = describe(source, name);
  }

  const keep = new Set<string>();
  const previousFiles = new Map((previous?.references ?? []).flatMap((ref) => ref.files.map((file) => [file.path, file] as const)));
  const previousFilePrompts = new Map(
    [...previousFiles.values()].filter((file) => file.prompt).map((file) => [file.prompt!, readText(join(source, file.prompt!))])
  );
  const imagePaths = new Map<ReferenceInput['files'][number], string>();
  const occupiedImages = new Set(input.references.flatMap((ref) => ref.files.flatMap((file) => (file.existingPath ? [file.existingPath] : []))));
  // После удаления первого вида его сосед может сохранить имя «-2»: новый файл не должен его перезаписать.
  for (const ref of input.references)
    for (const [index, file] of ref.files.entries()) {
      if (file.existingPath) {
        imagePaths.set(file, file.existingPath);
        continue;
      }
      const ext = extname(file.sourcePath!).toLowerCase();
      const extension = ext === '.jpeg' ? '.jpg' : ext;
      let suffix = index;
      let relative = `${dirOf.get(ref.kind)!}/${ref.id}${suffix ? `-${suffix + 1}` : ''}${extension}`;
      while (occupiedImages.has(relative)) relative = `${dirOf.get(ref.kind)!}/${ref.id}-${++suffix + 1}${extension}`;
      occupiedImages.add(relative);
      imagePaths.set(file, relative);
    }
  // Учитываем будущие записи до обхода файлов: общий старый путь может требоваться другому виду без изменений.
  const changedPromptPaths = new Set(
    input.references.flatMap((ref) =>
      ref.files.flatMap((file) => {
        const oldPath = file.existingPath ? previousFiles.get(file.existingPath)?.prompt : null;
        return file.prompt?.trim() && (!oldPath || normalizeText(previousFilePrompts.get(oldPath) ?? '') !== normalizeText(file.prompt))
          ? [`${imagePaths.get(file)!}.prompt.txt`]
          : [];
      })
    )
  );
  // Читаем общие промпты до записи: прежний произвольный путь может совпасть с новым промптом изображения.
  const previousPrompts = new Map(
    (previous?.references ?? []).map((ref) => [ref.id, { path: ref.prompt, text: ref.prompt ? readText(join(source, ref.prompt)) : '' }])
  );
  const savePrompt = (relative: string, text: string): void => {
    const path = join(source, relative);
    if (!existsSync(path) || normalizeText(readText(path)) !== normalizeText(text)) writeFileSync(path, normalizeText(text), 'utf-8');
    keep.add(relative);
  };
  const references: SourceReference[] = input.references.map((ref) => {
    const dir = dirOf.get(ref.kind)!;
    mkdirSync(join(source, dir), { recursive: true });
    const files: ReferenceFile[] = ref.files.map((file) => {
      const relative = imagePaths.get(file)!;
      if (!file.existingPath) {
        const target = join(source, relative);
        if (resolve(file.sourcePath!) !== resolve(target)) copyFileSync(file.sourcePath!, target);
      }
      keep.add(relative);
      const previousPrompt = file.existingPath ? previousFiles.get(file.existingPath)?.prompt : null;
      // Старый клиент не знает поле prompt и не должен удалять уже сохранённый промпт изображения.
      const unchanged =
        previousPrompt &&
        (file.prompt === undefined || (file.prompt.trim() && normalizeText(file.prompt) === normalizeText(previousFilePrompts.get(previousPrompt) ?? '')));
      let prompt = unchanged ? previousPrompt : file.prompt?.trim() ? `${relative}.prompt.txt` : null;
      if (prompt) {
        if (unchanged && changedPromptPaths.has(prompt)) {
          // Другой вид перезапишет общий путь; сохраняем прежние точные байты под собственным именем изображения.
          prompt = `${relative}.prompt.txt`;
          writeFileSync(join(source, prompt), previousFilePrompts.get(previousPrompt!) ?? '', 'utf-8');
        } else if (!unchanged && file.prompt !== undefined) savePrompt(prompt, file.prompt);
        keep.add(prompt);
      }
      return { ...describe(source, relative), view: file.view, note: file.note.trim(), prompt };
    });
    return {
      id: ref.id,
      kind: ref.kind,
      name: ref.name.trim(),
      short_name: ref.short_name.trim() || ref.name.trim(),
      description: ref.description.trim(),
      files,
      prompt: null
    };
  });
  // Общий legacy-промпт остаётся отдельным документом; не назначаем его изображениям.
  references.forEach((ref, index) => {
    const text = input.references[index].prompt;
    if (!text.trim()) return;
    const old = previousPrompts.get(ref.id);
    const dir = dirOf.get(ref.kind)!;
    let prompt = old?.path && normalizeText(old.text) === normalizeText(text) && !keep.has(old.path) ? old.path : `${dir}/${ref.id}.prompt.txt`;
    // Нестандартный старый путь может быть занят изображением или его промптом: сохраняем оба документа.
    for (let suffix = 0; keep.has(prompt); suffix++) prompt = `${dir}/${ref.id}.common${suffix ? `-${suffix + 1}` : ''}.prompt.txt`;
    if (old?.path === prompt && normalizeText(old.text) === normalizeText(text)) keep.add(prompt);
    else savePrompt(prompt, text);
    ref.prompt = prompt;
  });
  for (const ref of previous?.references ?? []) {
    for (const file of ref.files) {
      if (!keep.has(file.path)) rmSync(join(source, file.path), { force: true });
      if (file.prompt && !keep.has(file.prompt)) rmSync(join(source, file.prompt), { force: true });
    }
    if (ref.prompt && !keep.has(ref.prompt)) rmSync(join(source, ref.prompt), { force: true });
  }
  for (const dir of new Set([...kinds.map((k) => k.dir), ...(previous?.kinds ?? DEFAULT_SOURCE_KINDS).map((k) => k.dir)])) {
    const full = join(source, dir);
    if (existsSync(full) && readdirSync(full).filter((n) => n !== '.gitkeep').length === 0 && !existsSync(join(full, '.gitkeep')))
      rmSync(full, { recursive: true, force: true });
  }

  const manifest: SourceManifest = { schema_version: 1, kinds, track, lyrics, idea, cover, references, updated_at: new Date().toISOString() };
  writeFileSync(join(source, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf-8');
  return manifest;
}
