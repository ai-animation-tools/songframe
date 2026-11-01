/** Применение сценария: проверка в отдельной копии и ограниченное восстановление файлов после сбоя. */
import { scenarioTexts } from '@shared/texts/scenario';
import { createHash } from 'node:crypto';
import { constants, createReadStream, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, extname, isAbsolute, join, resolve } from 'node:path';
import type { ScenarioPublication } from '@shared/scenario-workflow';
import { initialStates, validateCast } from './cast';
import { writeAtomicBytes, writeLocalJson } from './local-files';
import type { PythonLauncher } from './python-launcher';
import { resolveStates, validateScenes, validateTreatment } from './scenario';
import { readProjectMarker } from './status';
import { sourceInputDigest } from './source-input-hash';
import { descriptionManifest, planCastDescriptions } from './cast-description-owner';

const FIXED_VIEWS = [
  'ROADMAP.md',
  'plan/edit-list.md',
  'plan/storyboard.md',
  'plan/context/characters.md',
  'plan/audio/timing.md',
  'assets/shots/manifest.json',
  'plan/animatic/cards/manifest.json'
];
const CANONICAL = ['plan/cast.json', 'plan/treatment.json', 'plan/scenes.json', 'source/manifest.json'];
const COPY_EXTENSIONS = new Set(['.json', '.md', '.txt', '.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp', '.tif', '.tiff', '.avif', '.svg']);
const SKIP_DIRECTORIES = new Set(['.git', '.local', '__pycache__', 'node_modules', 'cache']);
interface BackupEntry {
  path: string;
  backup: string | null;
  mode?: number;
}
interface PendingApplication {
  schemaVersion: 1;
  project: string;
  files: BackupEntry[];
}
interface Change {
  path: string;
  next: Buffer | null;
}

function relativePath(path: string): boolean {
  return !!path && !isAbsolute(path) && !/[\\\0:]/.test(path) && path.split('/').every((part) => !!part && part !== '.' && part !== '..');
}
function allowedTarget(path: string): boolean {
  return (
    relativePath(path) &&
    (CANONICAL.includes(path) ||
      FIXED_VIEWS.includes(path) ||
      /^assets\/shots\/M\d{2}(?:\.\d+)?\/README\.md$/.test(path) ||
      /^plan\/animatic\/cards\/[^/]+\.png$/.test(path))
  );
}
function fileStat(path: string): ReturnType<typeof lstatSync> | null {
  try {
    return lstatSync(path);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

/** Копии и восстановление не следуют ссылкам: даже скрытая папка не должна подменять рабочие данные. */
function checkedPath(project: string, relative: string): string {
  if (!relativePath(relative)) throw new Error(scenarioTexts.main.invalidRelativePath({ path: relative }));
  const parts = relative.split('/');
  for (let index = 1; index <= parts.length; index++) {
    const name = parts.slice(0, index).join('/');
    const stat = fileStat(join(project, name));
    if (!stat) continue;
    if (stat.isSymbolicLink() || (index < parts.length ? !stat.isDirectory() : !stat.isFile())) {
      throw new Error(scenarioTexts.main.ordinaryPathRequired({ name, directory: index < parts.length }));
    }
  }
  return join(project, relative);
}
function bytes(project: string, relative: string): Buffer | null {
  const path = checkedPath(project, relative);
  return fileStat(path) ? readFileSync(path) : null;
}
function digest(value: Uint8Array): string {
  return createHash('sha256').update(value).digest('hex');
}
async function fileDigest(project: string, relative: string): Promise<string | null> {
  const path = checkedPath(project, relative);
  if (!fileStat(path)) return null;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
async function verifyHashes(project: string, hashes: Record<string, string | null>): Promise<void> {
  for (const [path, expected] of Object.entries(hashes)) {
    // source/manifest в новых предложениях описывает содержательные входы, остальные файлы защищены побайтово.
    // Совпадающий прежний raw SHA остаётся допустим для предложений старой версии.
    if (path === 'source/manifest.json' && sourceInputDigest(project) === expected) continue;
    if ((await fileDigest(project, path)) !== expected) throw new Error(scenarioTexts.main.staleFile({ path }));
  }
}
function backupDirectory(localDir: string, project: string): string {
  return join(localDir, 'scenario-apply', digest(Buffer.from(project)));
}
function jsonBytes(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2) + '\n');
}

/** Копируется только входная метаинформация и изображения; полный монтаж и исходные генерации не нужны. */
async function stageInputs(project: string): Promise<string[]> {
  const files = new Set<string>();
  const visit = async (relative: string): Promise<void> => {
    const directory = join(project, relative);
    const stat = fileStat(directory);
    if (!stat) return;
    if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(scenarioTexts.main.stagingDirectoryRequired({ path: relative }));
    for (const item of await readdir(directory, { withFileTypes: true })) {
      if (SKIP_DIRECTORIES.has(item.name)) continue;
      const child = `${relative}/${item.name}`;
      if (item.isSymbolicLink()) throw new Error(scenarioTexts.main.stagingSymlink({ path: child }));
      if (item.isDirectory()) await visit(child);
      else if (item.isFile() && COPY_EXTENSIONS.has(extname(item.name).toLowerCase())) files.add(child);
    }
  };
  for (const folder of ['source', 'plan', 'assets']) await visit(folder);
  // ROADMAP входит в производные, но лежит вне трёх каталогов исходных материалов.
  if (fileStat(checkedPath(project, 'ROADMAP.md'))) files.add('ROADMAP.md');
  for (const path of [...files]) {
    if (!/^assets\/shots\/M\d{2}(?:\.\d+)?\/manifest\.json$/.test(path)) continue;
    const value = JSON.parse(readFileSync(checkedPath(project, path), 'utf8')) as { accepted_edit?: { video?: { path?: unknown } } };
    const video = value.accepted_edit?.video?.path;
    if (typeof video !== 'string' || !relativePath(video)) throw new Error(scenarioTexts.main.acceptedVideoPathRequired({ path }));
    const accepted = `${path.slice(0, -'manifest.json'.length)}${video}`;
    if (!fileStat(checkedPath(project, accepted))) throw new Error(scenarioTexts.main.acceptedVideoMissing({ path: accepted }));
    files.add(accepted);
  }
  return [...files].sort();
}
async function snapshot(project: string, paths: string[]): Promise<Record<string, string | null>> {
  const hashes: Record<string, string | null> = {};
  for (const path of paths) hashes[path] = await fileDigest(project, path);
  return hashes;
}
/** Известные производные, включая отсутствующие фиксированные файлы, входят в снимок предложения до запуска агента. */
export function scenarioOutputPaths(project: string): string[] {
  const outputs = new Set(FIXED_VIEWS);
  const cards = join(project, 'plan/animatic/cards');
  const cardsStat = fileStat(cards);
  if (cardsStat) {
    if (!cardsStat.isDirectory() || cardsStat.isSymbolicLink()) throw new Error(scenarioTexts.main.cardsDirectoryRequired);
    for (const entry of readdirSync(cards, { withFileTypes: true })) {
      if (entry.name.endsWith('.png')) outputs.add(`plan/animatic/cards/${entry.name}`);
    }
  }
  const shots = join(project, 'assets/shots');
  const shotsStat = fileStat(shots);
  if (shotsStat) {
    if (!shotsStat.isDirectory() || shotsStat.isSymbolicLink()) throw new Error(scenarioTexts.main.shotsDirectoryRequired);
    for (const entry of readdirSync(shots, { withFileTypes: true })) {
      if (/^M\d{2}(?:\.\d+)?$/.test(entry.name) && fileStat(join(shots, entry.name, 'README.md'))) outputs.add(`assets/shots/${entry.name}/README.md`);
    }
  }
  return [...outputs].sort();
}
function sameNames(before: string[], after: string[]): boolean {
  return JSON.stringify(before) === JSON.stringify(after);
}

/** Все резервные байты читаются до восстановления; при ошибке запись pending остаётся для следующего запуска. */
function restoreApplication(directory: string, pending: PendingApplication): void {
  // После переноса проекта нельзя создавать прежнюю папку из одних резервов и терять pending.
  // Пользователь возвращает доступ к исходному пути; другие проекты продолжают восстанавливаться отдельно.
  if (!existsSync(pending.project) || !readProjectMarker(pending.project)) {
    throw new Error(scenarioTexts.main.recoveryProjectUnavailable({ project: pending.project }));
  }
  checkedPath(pending.project, 'plan/project.json');
  const originals = pending.files.map((entry) => ({ entry, original: entry.backup === null ? null : readFileSync(join(directory, entry.backup)) }));
  for (const { entry } of originals) checkedPath(pending.project, entry.path);
  const problems: string[] = [];
  for (const { entry, original } of originals) {
    try {
      const target = checkedPath(pending.project, entry.path);
      if (original === null) rmSync(target, { force: true });
      else writeAtomicBytes(target, original, entry.mode);
    } catch (error) {
      problems.push(`${entry.path}: ${(error as Error).message}`);
    }
  }
  if (problems.length) throw new Error(problems.join(' '));
}
function clearBackups(directory: string): void {
  // После удаления pending остатки резервов уже не запускают откат успешного применения.
  try {
    rmSync(directory, { recursive: true, force: true });
  } catch {
    /* Резервы без pending можно убрать при следующем применении. */
  }
}
function publishChanges(project: string, localDir: string, changes: Change[]): void {
  if (!changes.length) return;
  const directory = backupDirectory(localDir, project);
  const pendingPath = join(directory, 'pending.json');
  if (existsSync(pendingPath)) throw new Error(scenarioTexts.main.recoveryPending);
  clearBackups(directory);
  mkdirSync(directory, { recursive: true });
  const pending: PendingApplication = { schemaVersion: 1, project, files: [] };
  // До первой замены сохраняются и прежние байты, и отсутствие каждого нового файла.
  for (const [index, change] of changes.entries()) {
    if (!allowedTarget(change.path)) throw new Error(scenarioTexts.main.unsupportedApplicationFile({ path: change.path }));
    const path = checkedPath(project, change.path);
    const previous = bytes(project, change.path);
    const backup = previous === null ? null : `${index}.bak`;
    const mode = fileStat(path)?.mode;
    if (backup) writeAtomicBytes(join(directory, backup), previous!);
    pending.files.push({ path: change.path, backup, ...(mode === undefined ? {} : { mode: Number(mode) & 0o777 }) });
  }
  writeLocalJson(pendingPath, pending);
  try {
    for (const change of changes) {
      const target = checkedPath(project, change.path);
      if (change.next === null) rmSync(target, { force: true });
      else writeAtomicBytes(target, change.next);
    }
    rmSync(pendingPath);
  } catch (error) {
    try {
      restoreApplication(directory, pending);
      rmSync(pendingPath);
      clearBackups(directory);
    } catch (restoreError) {
      throw new Error(scenarioTexts.main.recoveryIncomplete({ error: (error as Error).message, restoreError: (restoreError as Error).message }), {
        cause: restoreError
      });
    }
    throw error;
  }
  clearBackups(directory);
}
function changesFrom(project: string, candidates: Map<string, Buffer | null>): Change[] {
  const changes: Change[] = [];
  for (const [path, next] of candidates) {
    const previous = bytes(project, path);
    if (previous === null ? next === null : next !== null && previous.equals(next)) continue;
    changes.push({ path, next });
  }
  return changes;
}

/** Первый проход пишет только пару; сценический проход публикует лишь известные выходы штатных инструментов. */
export async function publishScenario(input: ScenarioPublication, options: { localDir: string; launcher: PythonLauncher }): Promise<void> {
  const project = resolve(input.project);
  if (!input.expectedHashes || !Object.keys(input.expectedHashes).length) throw new Error(scenarioTexts.main.snapshotMissing);
  await verifyHashes(project, input.expectedHashes);
  // Новая карточка или README между Start и Apply отсутствовали в исходном снимке, даже если прежние файлы не менялись.
  if (Object.hasOwn(input.expectedHashes, 'ROADMAP.md')) {
    const added = scenarioOutputPaths(project).find((path) => !Object.hasOwn(input.expectedHashes, path));
    if (added) throw new Error(scenarioTexts.main.staleAddedFile({ path: added }));
  }
  if (existsSync(join(backupDirectory(options.localDir, project), 'pending.json'))) throw new Error(scenarioTexts.main.recoveryPending);
  if (input.pass === 'treatment') {
    if (!input.after.cast || !input.after.treatment) throw new Error(scenarioTexts.main.applyPairRequired);
    const timing = bytes(project, 'plan/audio/timing.json');
    const duration = timing ? Number((JSON.parse(timing.toString('utf8')) as { duration_decoded?: number }).duration_decoded) : null;
    const problems = [...validateCast(input.after.cast), ...validateTreatment(input.after.treatment, duration)];
    if (problems.length) throw new Error(problems.join(' '));
    const originalManifest = bytes(project, 'source/manifest.json');
    const manifest = descriptionManifest(project);
    const plan = planCastDescriptions(input.after.cast, manifest, 'cast');
    const candidates = new Map([
      ['plan/cast.json', jsonBytes(plan.cast)],
      ['plan/treatment.json', jsonBytes(input.after.treatment)]
    ]);
    if (plan.manifest && JSON.stringify(plan.manifest) !== JSON.stringify(manifest)) candidates.set('source/manifest.json', jsonBytes(plan.manifest));
    await verifyHashes(project, input.expectedHashes);
    const currentManifest = bytes(project, 'source/manifest.json');
    if (originalManifest === null ? currentManifest !== null : !currentManifest?.equals(originalManifest))
      throw new Error(scenarioTexts.main.staleProjectFiles);
    publishChanges(project, options.localDir, changesFrom(project, candidates));
    return;
  }
  if (!input.after.scenes) throw new Error(scenarioTexts.main.proposedRegistryMissing);
  const problems = validateScenes(input.after.scenes, input.after.cast);
  if (problems.length) throw new Error(problems.join(' '));
  resolveStates(input.after.scenes, initialStates(input.after.cast));
  const initialFiles = await stageInputs(project);
  const initialOutputs = scenarioOutputPaths(project);
  const hashes = await snapshot(project, [...new Set([...initialFiles, ...initialOutputs])]);
  const stage = await mkdtemp(join(tmpdir(), 'songframe-scenario-apply-'));
  try {
    for (const relative of initialFiles) {
      const target = join(stage, relative);
      await mkdir(dirname(target), { recursive: true });
      await copyFile(checkedPath(project, relative), target, constants.COPYFILE_FICLONE);
      if ((await fileDigest(stage, relative)) !== hashes[relative]) throw new Error(scenarioTexts.main.staleStagingFile({ path: relative }));
    }
    writeLocalJson(join(stage, 'plan/scenes.json'), input.after.scenes);
    const run = async (name: string, args: string[]): Promise<void> => {
      const result = await options.launcher.run(stage, name, args);
      if (result.code !== 0)
        throw new Error(
          scenarioTexts.main.validationFailed({
            name,
            details: (result.stderr || result.stdout || scenarioTexts.main.validationExitCode({ code: result.code })).trim().slice(-1200)
          })
        );
    };
    await run('lint_registry', []);
    for (const scene of input.after.scenes.scenes) {
      for (const phase of ['before', 'after']) await run('continuity_brief', [scene.id, '--phase', phase, '--json']);
    }
    await run('update_scene_views', []);
    await run('update_scene_views', ['--check']);
    await verifyHashes(project, input.expectedHashes);
    await verifyHashes(project, hashes);
    if (!sameNames(initialFiles, await stageInputs(project)) || !sameNames(initialOutputs, scenarioOutputPaths(project))) {
      throw new Error(scenarioTexts.main.staleMaterials);
    }
    const candidates = new Map<string, Buffer | null>([['plan/scenes.json', jsonBytes(input.after.scenes)]]);
    for (const relative of new Set([...initialOutputs, ...scenarioOutputPaths(stage)])) candidates.set(relative, bytes(stage, relative));
    // Последняя проверка снимка непосредственно перед резервами и заменами; источники назад не копируются.
    await verifyHashes(project, input.expectedHashes);
    await verifyHashes(project, hashes);
    publishChanges(project, options.localDir, changesFrom(project, candidates));
  } finally {
    await rm(stage, { recursive: true, force: true });
  }
}

/** Вызывается при старте окна до открытия проектов; неизвестные пути из pending не восстанавливаются. */
export function recoverScenarioApplications(localDir: string): void {
  const base = join(localDir, 'scenario-apply');
  if (!existsSync(base)) return;
  const failures: string[] = [];
  for (const directoryName of readdirSync(base, { withFileTypes: true })) {
    if (!directoryName.isDirectory() || !/^[a-f0-9]{64}$/.test(directoryName.name)) continue;
    const directory = join(base, directoryName.name);
    const pendingPath = join(directory, 'pending.json');
    if (!existsSync(pendingPath)) continue;
    try {
      const value = JSON.parse(readFileSync(pendingPath, 'utf8')) as PendingApplication;
      if (
        value.schemaVersion !== 1 ||
        typeof value.project !== 'string' ||
        !isAbsolute(value.project) ||
        backupDirectory(localDir, resolve(value.project)) !== directory ||
        !Array.isArray(value.files) ||
        !value.files.length ||
        value.files.some(
          (entry, index) =>
            !entry ||
            !allowedTarget(entry.path) ||
            (entry.backup !== null && entry.backup !== `${index}.bak`) ||
            (entry.mode !== undefined && (!Number.isInteger(entry.mode) || entry.mode < 0 || entry.mode > 0o777))
        ) ||
        new Set(value.files.map((entry) => entry.path)).size !== value.files.length
      )
        throw new Error(scenarioTexts.main.recoveryFormatInvalid);
      restoreApplication(directory, value);
      rmSync(pendingPath);
      clearBackups(directory);
    } catch (error) {
      failures.push(`${directoryName.name}: ${(error as Error).message}`);
    }
  }
  if (failures.length) throw new Error(scenarioTexts.main.recoveryFailed({ failures: failures.join(' ') }));
}
