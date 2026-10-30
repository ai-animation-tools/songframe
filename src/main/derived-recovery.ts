/** Приёмка производного комплекта восстанавливается без Python до открытия проекта. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { derivedMainTexts as texts } from '@shared/texts/derived-shot-main';
import { readLocalJson, writeAtomicBytes, writeLocalJson } from './local-files';

interface Journal {
  schema_version: 1;
  id: string;
  shot: string;
  state: string;
  files: { path: string; before: string | null; after: string | null }[];
  directory: { path: string; before_files: Record<string, string> | null; after_files: Record<string, string>; backup: string; retired: string };
}
const DOCUMENTS = new Set([
  'plan/production-status.json',
  'ROADMAP.md',
  'plan/edit-list.md',
  'plan/storyboard.md',
  'plan/context/characters.md',
  'plan/audio/timing.md',
  'assets/shots/manifest.json',
  'plan/animatic/cards/manifest.json'
]);
const publicationFile = (path: string): boolean =>
  DOCUMENTS.has(path) || /^assets\/shots\/M\d{2}(?:\.\d+)?\/README\.md$/.test(path) || /^plan\/animatic\/cards\/[^/]+\.png$/.test(path);
const HASH = /^[a-f0-9]{64}$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const local = (path: unknown): path is string =>
  typeof path === 'string' &&
  !!path &&
  !path.includes('\\') &&
  !path.startsWith('/') &&
  !path.split('/').some((part) => part === '..' || part === '' || part === '.');
const descriptorMap = (value: unknown): value is Record<string, string> =>
  record(value) && Object.entries(value).every(([path, sha]) => local(path) && typeof sha === 'string' && HASH.test(sha));
const digest = (path: string): string | null => (existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null);
function files(path: string): Record<string, string> | null {
  if (!existsSync(path)) return null;
  const result: Record<string, string> = {};
  const walk = (directory: string, prefix: string): void => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const name = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isSymbolicLink()) throw new Error(texts.recoveryFailed({ path: directory }));
      if (entry.isDirectory()) walk(join(directory, entry.name), name);
      else if (entry.isFile()) result[name] = digest(join(directory, entry.name))!;
    }
  };
  if (!lstatSync(path).isDirectory()) throw new Error(texts.recoveryFailed({ path }));
  walk(path, '');
  return result;
}
function same(a: Record<string, string> | null, b: Record<string, string> | null): boolean {
  if (a === null || b === null) return a === b;
  return Object.keys(a).length === Object.keys(b).length && Object.entries(a).every(([path, sha]) => b[path] === sha);
}

/** До первой записи сверяем весь набор и резерв: прерванный откат можно безопасно повторить. */
export function recoverDerivedApplications(project: string): void {
  const history = join(project, 'plan/derived-history');
  if (!existsSync(history)) return;
  for (const entry of readdirSync(history, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^(?:[a-f0-9]{32}|[a-f0-9-]{36})$/.test(entry.name)) continue;
    const directory = join(history, entry.name);
    const path = join(directory, 'journal.json');
    const journal = readLocalJson<Journal>(path);
    if (!journal || journal.state !== 'publishing') continue;
    const fail = (): never => {
      throw new Error(texts.recoveryFailed({ path }));
    };
    if (
      journal.schema_version !== 1 ||
      journal.id !== entry.name ||
      !/^M\d{2}(?:\.\d+)?$/.test(journal.shot) ||
      !Array.isArray(journal.files) ||
      !record(journal.directory)
    )
      fail();
    const kit = journal.directory;
    if (
      kit.path !== `assets/shots/${journal.shot}` ||
      kit.backup !== `plan/derived-history/${entry.name}/before-kit` ||
      kit.retired !== `assets/replaced/${journal.shot}/${entry.name}` ||
      (kit.before_files !== null && !descriptorMap(kit.before_files)) ||
      !descriptorMap(kit.after_files)
    )
      fail();
    if (
      journal.files.some(
        (file) =>
          !file ||
          !local(file.path) ||
          !publicationFile(file.path) ||
          [file.before, file.after].some((sha) => sha !== null && (typeof sha !== 'string' || !HASH.test(sha)))
      ) ||
      new Set(journal.files.map((file) => file.path)).size !== journal.files.length
    )
      fail();
    const current = files(join(project, kit.path));
    if (current !== null && !same(current, kit.before_files) && !same(current, kit.after_files)) fail();
    if (kit.before_files !== null && !same(files(join(project, kit.backup)), kit.before_files)) fail();
    if (existsSync(join(project, kit.retired)) && !same(files(join(project, kit.retired)), kit.before_files)) fail();
    const backups = journal.files.map((file) => {
      const current = digest(join(project, file.path));
      if (current !== file.before && current !== file.after) fail();
      const bytes = file.before === null ? null : readFileSync(join(directory, 'before', file.path));
      if (bytes !== null && createHash('sha256').update(bytes).digest('hex') !== file.before) fail();
      return { file, bytes };
    });
    if (kit.before_files === null) rmSync(join(project, kit.path), { recursive: true, force: true });
    else {
      const temporary = join(directory, 'restore-kit');
      rmSync(temporary, { recursive: true, force: true });
      cpSync(join(project, kit.backup), temporary, { recursive: true });
      rmSync(join(project, kit.path), { recursive: true, force: true });
      mkdirSync(dirname(join(project, kit.path)), { recursive: true });
      renameSync(temporary, join(project, kit.path));
    }
    for (const { file, bytes } of backups.reverse()) {
      if (bytes === null) rmSync(join(project, file.path), { force: true });
      else writeAtomicBytes(join(project, file.path), bytes);
    }
    rmSync(join(project, kit.retired), { recursive: true, force: true });
    writeLocalJson(path, { ...journal, state: 'rolled_back' });
    rmSync(join(directory, 'staging'), { recursive: true, force: true });
  }
}
