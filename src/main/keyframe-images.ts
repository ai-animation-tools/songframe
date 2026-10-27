/** Первый исполнитель опор: Codex пишет только кандидаты, регистрация и принятие принадлежат производственному процессу. */
import { randomUUID, createHash } from 'node:crypto';
import { copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentJob, AgentStartInput } from '@shared/agents';
import type { ProductionFrameCandidate, ProductionImagesInput } from '@shared/production-workflow';
import { writeLocalJson, readLocalJson } from './local-files';

interface ImagesRecord {
  schemaVersion: 1;
  jobId: string;
  project: string;
  ids: string[];
  inputs: { path: string; copy: string; sha256: string }[];
  requestSha?: string;
}
interface Options {
  localDir: string;
  agents: { startImages(input: AgentStartInput, workDir: string): AgentJob };
  validateImage?: (path: string) => boolean;
}
const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');

/** Сопоставляем расширение с исходными байтами, не переименовывая и не перекодируя результат генератора. */
export function imageExtensionMatches(path: string): boolean {
  if (!existsSync(path) || !lstatSync(path).isFile()) return false;
  const bytes = readFileSync(path);
  const suffix = extname(path).toLowerCase();
  if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return suffix === '.png';
  if (bytes.length >= 3 && bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return suffix === '.jpg' || suffix === '.jpeg';
  if (bytes.length >= 12 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return suffix === '.webp';
  return false;
}

/** Размер берётся из фактического формата, поэтому JPEG/WebP не нужно переименовывать в PNG. */
export function imageDimensions(path: string): { width: number; height: number } | null {
  if (!existsSync(path) || !lstatSync(path).isFile()) return null;
  const bytes = readFileSync(path);
  let width = 0,
    height = 0;
  if (bytes.length > 24 && bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
    width = bytes.readUInt32BE(16);
    height = bytes.readUInt32BE(20);
  } else if (bytes.length > 3 && bytes[0] === 255 && bytes[1] === 216) {
    for (let offset = 2; offset + 4 <= bytes.length;) {
      if (bytes[offset] !== 255) break;
      const marker = bytes[offset + 1];
      if (marker === 217 || marker === 218) break;
      const length = bytes.readUInt16BE(offset + 2);
      if (length < 2 || offset + 2 + length > bytes.length) break;
      if ([192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207].includes(marker) && length >= 7) {
        height = bytes.readUInt16BE(offset + 5);
        width = bytes.readUInt16BE(offset + 7);
        break;
      }
      offset += length + 2;
    }
  } else if (bytes.length >= 25 && bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') {
    const format = bytes.toString('ascii', 12, 16);
    if (format === 'VP8X' && bytes.length >= 30) {
      width = bytes.readUIntLE(24, 3) + 1;
      height = bytes.readUIntLE(27, 3) + 1;
    } else if (format === 'VP8 ' && bytes.length >= 30 && bytes.subarray(23, 26).equals(Buffer.from([157, 1, 42]))) {
      width = bytes.readUInt16LE(26) & 0x3fff;
      height = bytes.readUInt16LE(28) & 0x3fff;
    } else if (format === 'VP8L' && bytes[20] === 47) {
      const bits = bytes.readUInt32LE(21);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
  }
  return width > 0 && height > 0 ? { width, height } : null;
}

export function isImageFile(path: string): boolean {
  return imageDimensions(path) !== null;
}

export class KeyframeImages {
  constructor(private readonly options: Options) {}

  start(input: ProductionImagesInput, requestSha?: string): AgentJob {
    const project = realpathSync(input.project);
    if (!input.frames.length || input.frames.some((frame) => !/^K\d{2}$/.test(frame.id) || !frame.prompt.trim()))
      throw new Error('Сначала подготовьте описания опор.');
    const base = join(this.options.localDir, 'image-jobs');
    const directory = join(base, randomUUID());
    mkdirSync(directory, { recursive: true });
    const inputs: ImagesRecord['inputs'] = [];
    const copies = new Map<string, string>();
    const frames = input.frames.map((frame) => ({
      ...frame,
      referencePaths: frame.referencePaths.map((path) => {
        const source = resolve(project, path);
        const local = relative(project, realpathSync(source));
        if (isAbsolute(local) || local.startsWith('..') || !isImageFile(source)) throw new Error(`Недоступен референс опоры: ${path}`);
        if (!copies.has(source)) {
          const target = `reference-${String(copies.size + 1).padStart(2, '0')}${extname(source).toLowerCase()}`;
          copyFileSync(source, join(directory, target));
          chmodSync(join(directory, target), 0o444);
          copies.set(source, target);
          inputs.push({ path: source, copy: target, sha256: digest(source) });
        }
        return copies.get(source)!;
      })
    }));
    const job = this.options.agents.startImages(
      {
        project,
        task: `Опоры ${input.shot}: Codex`,
        prompt:
          'Создай перечисленные опорные изображения встроенным инструментом генерации изображений. Используй только переданные копии референсов. ' +
          'Сохрани каждый результат как Kxx.png, Kxx.jpg или Kxx.webp в текущей папке, сохраняя фактический формат генератора. Не используй Kling, API-ключи или другие генераторы. ' +
          'Если встроенный image tool недоступен, сообщи об этом и не подменяй его другим способом. ' +
          'Не изменяй референсы, исходный проект или принятые материалы. ' +
          'Финальный ответ — один JSON без Markdown: {"schemaVersion":1,"stage":"frames","images":[{"id":"K01","path":"K01.png"}]}.',
        context: JSON.stringify({ stage: 'frames', shot: input.shot, frames })
      },
      directory
    );
    writeLocalJson(join(directory, 'job.json'), {
      schemaVersion: 1,
      jobId: job.id,
      project,
      ...(requestSha ? { requestSha } : {}),
      ids: frames.map((frame) => frame.id),
      inputs
    } satisfies ImagesRecord);
    return job;
  }

  collect(job: AgentJob, requestSha?: string): ProductionFrameCandidate[] {
    if (job.provider !== 'codex' || job.status !== 'completed' || job.exitCode !== 0) throw new Error('Задание опор не завершено успешно.');
    const base = join(this.options.localDir, 'image-jobs');
    for (const entry of existsSync(base) ? readdirSync(base, { withFileTypes: true }) : []) {
      if (!entry.isDirectory()) continue;
      const directory = join(base, entry.name);
      let record: ImagesRecord | null;
      try {
        record = readLocalJson<ImagesRecord>(join(directory, 'job.json'));
      } catch {
        continue;
      }
      if (record?.jobId !== job.id) continue;
      if (requestSha && record.requestSha !== requestSha) throw new Error('Задание опор относится к другому согласованному запросу.');
      if (record.schemaVersion !== 1 || record.project !== job.project || !Array.isArray(record.ids) || !Array.isArray(record.inputs))
        throw new Error('Повреждена запись задания опор.');
      for (const file of record.inputs)
        if (
          !existsSync(file.path) ||
          digest(file.path) !== file.sha256 ||
          !existsSync(join(directory, file.copy)) ||
          digest(join(directory, file.copy)) !== file.sha256
        )
          throw new Error('Референсы изменились: подготовьте опоры заново.');
      const response: unknown = JSON.parse(job.result);
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error('Codex не вернул список файлов опор.');
      const value = response as Record<string, unknown>;
      if (
        value.schemaVersion !== 1 ||
        value.stage !== 'frames' ||
        Object.keys(value).some((key) => !['schemaVersion', 'stage', 'images'].includes(key)) ||
        !Array.isArray(value.images)
      )
        throw new Error('Неверный контракт результата опор.');
      const candidates = value.images.map((candidate: unknown) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error('Неверная запись опоры.');
        const item = candidate as Record<string, unknown>;
        if (typeof item.id !== 'string' || typeof item.path !== 'string' || Object.keys(item).some((key) => key !== 'id' && key !== 'path'))
          throw new Error('Неверный путь опоры.');
        const file = resolve(directory, item.path);
        const local = relative(directory, file);
        if (
          record.inputs.some((input) => input.copy === local) ||
          isAbsolute(item.path) ||
          local.startsWith('..') ||
          isAbsolute(local) ||
          lstatSync(file).isSymbolicLink() ||
          realpathSync(file) !== file ||
          !isImageFile(file) ||
          (this.options.validateImage && !this.options.validateImage(file))
        )
          throw new Error(`Опора ${item.id}: нужен настоящий файл изображения в папке кандидатов.`);
        if (!imageExtensionMatches(file))
          throw new Error(`Опора ${item.id}: расширение не соответствует фактическому формату изображения. Исходный файл сохранён.`);
        return { id: item.id, path: file };
      });
      if (
        candidates.length !== record.ids.length ||
        new Set(candidates.map((item) => item.id)).size !== record.ids.length ||
        candidates.some((item) => !record.ids.includes(item.id))
      )
        throw new Error('Codex вернул не все согласованные опоры.');
      return record.ids.map((id) => candidates.find((candidate) => candidate.id === id)!);
    }
    throw new Error('Рабочая папка опор недоступна. Подготовьте новое задание.');
  }

  /** После перезапуска восстанавливаем связь с запросом из существующей записи, не создавая второй журнал. */
  getRequestSha(job: AgentJob): string | null {
    const base = join(this.options.localDir, 'image-jobs');
    for (const entry of existsSync(base) ? readdirSync(base, { withFileTypes: true }) : []) {
      if (!entry.isDirectory()) continue;
      let record: ImagesRecord | null;
      try {
        record = readLocalJson<ImagesRecord>(join(base, entry.name, 'job.json'));
      } catch {
        continue;
      }
      if (record?.jobId !== job.id) continue;
      if (record.schemaVersion !== 1 || record.project !== job.project) throw new Error('Повреждена запись задания опор.');
      if (record.requestSha === undefined) return null;
      if (typeof record.requestSha !== 'string' || !/^[a-f0-9]{64}$/.test(record.requestSha)) throw new Error('Повреждён SHA запроса опор.');
      return record.requestSha;
    }
    throw new Error('Рабочая папка опор недоступна. Подготовьте новое задание.');
  }
}
