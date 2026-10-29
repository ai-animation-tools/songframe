/** При старте окна восстанавливает прерванную замену сцен без Python; @link ../../docs/montage.md. */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { readLocalJson, writeAtomicBytes, writeLocalJson } from './local-files';

interface Journal {
  schema_version: 1;
  id: string;
  state: string;
  files: { path: string; before: string | null; after: string | null }[];
}
const FIXED = new Set([
  'plan/scenes.json',
  'plan/production-status.json',
  'ROADMAP.md',
  'plan/edit-list.md',
  'plan/storyboard.md',
  'plan/context/characters.md',
  'plan/audio/timing.md',
  'assets/shots/manifest.json',
  'plan/animatic/cards/manifest.json'
]);
function targetAllowed(path: string): boolean {
  return (
    FIXED.has(path) ||
    /^assets\/shots\/M\d{2}(?:\.\d+)?\/(manifest\.json|README\.md)$/.test(path) ||
    /^plan\/animatic\/cards\/M\d{2}(?:\.\d+)?\.png$/.test(path)
  );
}
function digest(path: string): string | null {
  return existsSync(path) ? createHash('sha256').update(readFileSync(path)).digest('hex') : null;
}

/** Весь набор проверяется до первой записи: последующая ручная правка не теряется от отката. */
export function recoverMontageApplications(project: string): void {
  const history = join(project, 'plan/montage-history');
  if (!existsSync(history)) return;
  for (const entry of readdirSync(history, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[a-f0-9]{32}$/.test(entry.name)) continue;
    const directory = join(history, entry.name);
    const path = join(directory, 'journal.json');
    const journal = readLocalJson<Journal>(path);
    if (!journal || journal.state !== 'publishing') continue;
    if (
      journal.schema_version !== 1 ||
      journal.id !== entry.name ||
      !Array.isArray(journal.files) ||
      journal.files.some(
        (file) =>
          !file ||
          typeof file.path !== 'string' ||
          !targetAllowed(file.path) ||
          [file.before, file.after].some((sha) => sha !== null && (typeof sha !== 'string' || !/^[a-f0-9]{64}$/.test(sha)))
      ) ||
      new Set(journal.files.map((file) => file.path)).size !== journal.files.length
    )
      throw new Error(`Неизвестный журнал ручного монтажа: ${path}. Резервы сохранены.`);
    const backups = journal.files.map((file) => {
      const current = digest(join(project, file.path));
      if (current !== file.before && current !== file.after)
        throw new Error(`После прерывания монтажа изменён ${file.path}. Восстановление остановлено; резервы: ${directory}.`);
      const backup = file.before === null ? null : readFileSync(join(directory, 'before', file.path));
      if (backup !== null && createHash('sha256').update(backup).digest('hex') !== file.before) throw new Error(`Повреждён резерв ${file.path}: ${directory}.`);
      return { file, backup };
    });
    for (const { file, backup } of backups.reverse()) {
      if (backup === null) rmSync(join(project, file.path), { force: true });
      else writeAtomicBytes(join(project, file.path), backup);
    }
    writeLocalJson(path, { ...journal, state: 'rolled_back' });
    rmSync(join(directory, 'staging'), { recursive: true, force: true });
  }
}
