/** Узкий журнал замены рабочего пакета: платные попытки никогда не откатываются и не заменяются. */
import { isPaidMediaProvider } from '@shared/media-providers';
import { createHash, randomUUID } from 'node:crypto';
import { cpSync, existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, renameSync, rmdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { productionPath, record } from './production-proposal';

const digest = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
interface ProtectedImage {
  requestDir: string;
  requestSha256: string;
  frameId: string;
  /** null обозначает папку: даже пустые каталоги защищённой попытки сохраняются. */
  files: Record<string, string | null>;
}
interface Pending {
  schemaVersion: 1 | 2;
  project: string;
  packageDir: string;
  existed: boolean;
  protectedImages?: ProtectedImage[];
}
function packagePath(project: string, path: string): string {
  const full = productionPath(project, path);
  const local = relative(project, full).split('\\').join('/');
  if (!/^plan\/(batches|awaiting)\/[^/]+$/.test(local)) throw new Error('Нужен отдельный рабочий пакет внутри plan/batches или plan/awaiting.');
  return full;
}
function workflow(directory: string): Record<string, unknown> {
  const path = join(directory, 'workflow.json');
  if (!existsSync(path)) return {};
  const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
  if (!record(value)) throw new Error('Повреждён workflow рабочего пакета.');
  return value;
}
function nested(path: string, parent: string): boolean {
  return path === parent || path.startsWith(parent + sep);
}
/** Неопознанная оплата тоже запрещает откат; исключения задаются только проверенными image roots. */
function attemptsPaid(directory: string, excluded: string[] = []): boolean {
  if (!existsSync(directory) || excluded.includes(directory)) return false;
  const entries = readdirSync(directory, { withFileTypes: true });
  if (entries.some((entry) => /^original(?:-\d+)?\.(mp4|png|jpe?g|webp)$/i.test(entry.name))) return true;
  const path = join(directory, 'attempt.json');
  if (existsSync(path)) {
    try {
      const attempt: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!record(attempt) || attempt.status !== 'prepared' || attempt.generation_id) return true;
    } catch {
      return true;
    }
  }
  return entries.some((entry) => entry.isDirectory() && attemptsPaid(join(directory, entry.name), excluded));
}
function videoStage(directory: string, data = workflow(directory)): boolean {
  return ['submitted', 'downloaded', 'edit_review', 'accepted'].includes(String(data.stage));
}
function paid(directory: string): boolean {
  return existsSync(directory) && (videoStage(directory) || attemptsPaid(directory));
}
export const productionPackagePaid = paid;

function imageRoots(directory: string, data = workflow(directory)): Omit<ProtectedImage, 'files'>[] {
  if (data.image_requests === undefined) {
    if (data.image_request_dir) throw new Error('Активная image-попытка отсутствует в истории.');
    return [];
  }
  if (!Array.isArray(data.image_requests)) throw new Error('Повреждена история запросов изображений.');
  const roots: Omit<ProtectedImage, 'files'>[] = [];
  for (const item of data.image_requests) {
    if (
      !record(item) ||
      !isPaidMediaProvider(item.provider) ||
      typeof item.frame_id !== 'string' ||
      !/^K\d{2}$/.test(item.frame_id) ||
      typeof item.request_dir !== 'string' ||
      !item.request_dir ||
      isAbsolute(item.request_dir) ||
      typeof item.request_sha256 !== 'string' ||
      !/^[a-f0-9]{64}$/.test(item.request_sha256)
    )
      throw new Error('Неверная запись истории image-попытки.');
    const path = resolve(directory, item.request_dir);
    const local = relative(directory, path);
    if (!local || local === '..' || local.startsWith('..' + sep) || isAbsolute(local) || !existsSync(path) || realpathSync(path) !== path)
      throw new Error('Папка image-попытки недоступна внутри пакета.');
    if (roots.some((root) => nested(path, resolve(directory, root.requestDir)) || nested(resolve(directory, root.requestDir), path)))
      throw new Error('Папки image-попыток пересекаются.');
    if (typeof data.request_dir === 'string' && resolve(directory, data.request_dir) === path)
      throw new Error('Image-попытка не должна заменять video request_dir.');
    const requestBytes = readFileSync(join(path, 'request.json'));
    const request: unknown = JSON.parse(requestBytes.toString('utf8'));
    const attempt: unknown = JSON.parse(readFileSync(join(path, 'attempt.json'), 'utf8'));
    if (
      !record(request) ||
      request.kind !== 'image' ||
      !['text_to_image', 'image_to_image'].includes(String(request.command)) ||
      !record(attempt) ||
      ![
        'prepared',
        'submitting',
        'submission_unknown',
        'submitted',
        'running',
        'downloading',
        'download_pending',
        'outputs_pending',
        'watermark_free_pending',
        'downloaded',
        'failed'
      ].includes(String(attempt.status)) ||
      attempt.request_sha256 !== item.request_sha256 ||
      digest(requestBytes) !== item.request_sha256
    )
      throw new Error('SHA или kind защищённой image-попытки не совпадает с историей.');
    if (
      readdirSync(path, { withFileTypes: true }).some(
        (entry) => /^original(?:-\d+)?\.mp4$/i.test(entry.name) || (entry.isDirectory() && attemptsPaid(join(path, entry.name)))
      )
    )
      throw new Error('Image-попытка содержит видео или вложенную неизвестную оплату.');
    roots.push({ requestDir: local, requestSha256: item.request_sha256, frameId: item.frame_id });
  }
  return roots;
}
/** Известные image originals остаются на месте; видео и неизвестная оплата по-прежнему блокируют Apply. */
export function productionPackageVideoPaid(directory: string): boolean {
  if (!existsSync(directory)) return false;
  try {
    if (videoStage(directory)) return true;
    const roots = imageRoots(directory).map((item) => resolve(directory, item.requestDir));
    return attemptsPaid(directory, roots);
  } catch {
    return true;
  }
}
function files(directory: string): ProtectedImage['files'] {
  const result: ProtectedImage['files'] = {};
  function visit(folder: string): void {
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      const path = join(folder, entry.name);
      const local = relative(directory, path);
      if (lstatSync(path).isSymbolicLink()) throw new Error('Защищённая image-попытка содержит ссылку вместо локального файла.');
      if (entry.isDirectory()) {
        result[local] = null;
        visit(path);
      } else if (entry.isFile()) result[local] = digest(readFileSync(path));
      else throw new Error('Защищённая image-попытка содержит неизвестный тип файла.');
    }
  }
  visit(directory);
  return Object.fromEntries(Object.entries(result).sort(([a], [b]) => a.localeCompare(b)));
}
function verifyImages(target: string, protectedImages: ProtectedImage[], data = workflow(target)): void {
  const current = imageRoots(target, data);
  if (current.length !== protectedImages.length) throw new Error('История защищённых image-попыток изменилась.');
  for (const image of protectedImages) {
    const root = current.find((item) => item.requestDir === image.requestDir);
    if (
      !root ||
      root.requestSha256 !== image.requestSha256 ||
      root.frameId !== image.frameId ||
      JSON.stringify(files(resolve(target, image.requestDir))) !== JSON.stringify(image.files)
    )
      throw new Error('Защищённая image-попытка или её оригиналы изменились; автоматическое восстановление остановлено.');
  }
  if (
    videoStage(target, data) ||
    attemptsPaid(
      target,
      current.map((image) => resolve(target, image.requestDir))
    )
  )
    throw new Error('Пакет содержит видео или неизвестную платную попытку; резерв сохранён.');
}
function copyMutable(source: string, target: string, protectedImages: ProtectedImage[]): void {
  cpSync(source, target, {
    recursive: true,
    filter: (path) => !protectedImages.some((image) => nested(path, resolve(source, image.requestDir)))
  });
}
/** Удаляется только изменяемая часть: ни пакет целиком, ни платные image roots не заменяются. */
function removeMutable(target: string, protectedImages: ProtectedImage[]): void {
  if (!existsSync(target)) return;
  const roots = protectedImages.map((image) => resolve(target, image.requestDir));
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (roots.includes(path)) continue;
      if (entry.isDirectory() && roots.some((root) => nested(root, path))) visit(path);
      else rmSync(path, { recursive: true, force: true });
    }
  }
  visit(target);
}
function restore(directory: string, pending: Pending): void {
  if (!existsSync(join(pending.project, 'plan/project.json'))) throw new Error('Проект недоступен по прежнему пути; резерв сохранён.');
  const target = packagePath(pending.project, pending.packageDir);
  const protectedImages = pending.schemaVersion === 2 ? pending.protectedImages! : [];
  const backup = join(directory, 'package');
  if (pending.existed && !existsSync(backup)) throw new Error('Отсутствует резерв рабочего пакета.');
  if (pending.schemaVersion === 2) {
    // Обрыв после удаления mutable files оставляет originals на месте, но временно убирает workflow.
    // Только в этом случае его backup доказывает прежнюю history; существующий чужой workflow не заменяем.
    const proof = !existsSync(join(target, 'workflow.json')) && pending.existed ? workflow(backup) : workflow(target);
    verifyImages(target, protectedImages, proof);
  } else if (paid(target)) throw new Error('Пакет уже содержит платную попытку; автоматическое восстановление остановлено, резерв сохранён.');
  if (pending.existed && paid(backup)) throw new Error('Резерв содержит платную попытку; автоматическое восстановление остановлено.');
  removeMutable(target, protectedImages);
  if (pending.existed) copyMutable(backup, target, protectedImages);
  else if (existsSync(target)) rmdirSync(target);
}
export async function applyProductionPackage(localDir: string, project: string, target: string, apply: () => Promise<void>): Promise<void> {
  const packageDir = packagePath(project, target);
  if (productionPackageVideoPaid(packageDir)) throw new Error('После платной отправки видео или неизвестного запроса нужна новая попытка с retry_of.');
  if (['image_request_choice', 'image_submitted', 'image_downloaded'].includes(String(workflow(packageDir).stage)))
    throw new Error('Сначала завершите image-попытку и выберите опору.');
  const directory = join(localDir, 'production-apply', digest(`${project}\0${packageDir}`));
  const pendingPath = join(directory, 'pending.json');
  if (existsSync(pendingPath)) throw new Error('Предыдущее применение не восстановлено. Перезапустите приложение.');
  const protectedImages = imageRoots(packageDir).map((item) => ({ ...item, files: files(resolve(packageDir, item.requestDir)) }));
  rmSync(directory, { recursive: true, force: true });
  mkdirSync(directory, { recursive: true });
  const pending: Pending = { schemaVersion: 2, project, packageDir: relative(project, packageDir), existed: existsSync(packageDir), protectedImages };
  if (pending.existed) copyMutable(packageDir, join(directory, 'package'), protectedImages);
  writeFileSync(pendingPath, JSON.stringify(pending));
  try {
    await apply();
    verifyImages(packageDir, protectedImages);
  } catch (error) {
    try {
      restore(directory, pending);
      rmSync(directory, { recursive: true, force: true });
    } catch (restoreError) {
      throw new Error(`Применение прервано: ${String(error)}. Восстановление не завершено: ${String(restoreError)}. Резерв сохранён.`, { cause: restoreError });
    }
    throw error;
  }
  // Сначала убирается намерение отката; оставшийся резерв не откатит успешно завершённый Apply.
  rmSync(pendingPath);
  rmSync(directory, { recursive: true, force: true });
}
export function writeProductionJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`);
  renameSync(temporary, path);
}
/** До открытия проектов восстанавливается только явно записанная незавершённая замена пакета. */
export function recoverInterruptedProductionApplies(localDir: string): void {
  const base = join(localDir, 'production-apply');
  if (!existsSync(base)) return;
  const errors: string[] = [];
  for (const name of readdirSync(base)) {
    if (!/^[a-f0-9]{64}$/.test(name)) continue;
    const directory = join(base, name);
    const path = join(directory, 'pending.json');
    if (!existsSync(path)) continue;
    try {
      const pending: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (
        !record(pending) ||
        (pending.schemaVersion !== 1 && pending.schemaVersion !== 2) ||
        typeof pending.project !== 'string' ||
        !isAbsolute(pending.project) ||
        typeof pending.packageDir !== 'string' ||
        isAbsolute(pending.packageDir) ||
        typeof pending.existed !== 'boolean'
      )
        throw new Error('Неверная запись восстановления.');
      if (
        pending.schemaVersion === 2 &&
        (!Array.isArray(pending.protectedImages) ||
          pending.protectedImages.some(
            (image) =>
              !record(image) ||
              typeof image.requestDir !== 'string' ||
              !image.requestDir ||
              isAbsolute(image.requestDir) ||
              relative('.', image.requestDir).split(sep).includes('..') ||
              typeof image.requestSha256 !== 'string' ||
              !/^[a-f0-9]{64}$/.test(image.requestSha256) ||
              typeof image.frameId !== 'string' ||
              !/^K\d{2}$/.test(image.frameId) ||
              !record(image.files) ||
              Object.values(image.files).some((hash) => hash !== null && (typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash)))
          ))
      )
        throw new Error('Неверный снимок защищённых image-попыток.');
      const target = packagePath(pending.project, pending.packageDir);
      if (digest(`${resolve(pending.project)}\0${target}`) !== basename(directory)) throw new Error('Путь восстановления не совпадает с журналом.');
      restore(directory, pending as unknown as Pending);
      rmSync(path);
      rmSync(directory, { recursive: true, force: true });
    } catch (error) {
      errors.push(String(error));
    }
  }
  if (errors.length) throw new Error(`Не удалось восстановить применение производства: ${errors.join(' ')}`);
}
