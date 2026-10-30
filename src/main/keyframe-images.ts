/** Опоры провайдера-агента: программа пишет только кандидаты, регистрация и принятие принадлежат производственному процессу. */
import { productionTexts } from '@shared/texts/production';
import { randomUUID, createHash } from 'node:crypto';
import { copyFileSync, chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync } from 'node:fs';
import { extname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentJob, AgentSettings, AgentStartInput } from '@shared/agents';
import { mediaProviderInfo, mediaProviderTitle, type MediaProviderId } from '@shared/media-providers';
import type { ProductionFrameCandidate, ProductionImagesInput } from '@shared/production-workflow';
import { writeLocalJson, readLocalJson } from './local-files';

const texts = productionTexts.main.images;

interface ImagesRecord {
  schemaVersion: 1;
  jobId: string;
  project: string;
  /** Провайдер изображений, чья программа-агент выполняет задание. */
  provider: MediaProviderId;
  requestSha: string;
  ids: string[];
  inputs: { path: string; copy: string; sha256: string }[];
}
/** Согласованный запуск: провайдер, SHA запроса и программа-агент с моделью. */
export interface KeyframeImagesRequest {
  provider: MediaProviderId;
  requestSha: string;
  agent: AgentSettings;
}
interface Options {
  localDir: string;
  agents: { startImages(input: AgentStartInput, workDir: string, config: AgentSettings): AgentJob };
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

  start(input: ProductionImagesInput, request: KeyframeImagesRequest): AgentJob {
    const project = realpathSync(input.project);
    if (!input.frames.length || input.frames.some((frame) => !/^K\d{2}$/.test(frame.id) || !frame.prompt.trim()))
      throw new Error(texts.frameDescriptionsRequired);
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
        if (isAbsolute(local) || local.startsWith('..') || !isImageFile(source)) throw new Error(texts.referenceUnavailable({ path }));
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
    // Утверждённые опоры пакета копируются рядом с референсами: следующий кадр согласуется с ними.
    const approved = (input.approvedFrames ?? []).map((frame) => {
      if (!/^K\d{2}$/.test(frame.id) || !isImageFile(frame.path)) throw new Error(texts.approvedFrameUnavailable({ frame: frame.id }));
      const copy = `approved-${frame.id}${extname(frame.path).toLowerCase()}`;
      copyFileSync(frame.path, join(directory, copy));
      chmodSync(join(directory, copy), 0o444);
      inputs.push({ path: frame.path, copy, sha256: digest(frame.path) });
      return { id: frame.id, role: frame.role, path: copy };
    });
    const notes = (input.notes ?? []).map((note) => note.trim()).filter(Boolean);
    const job = this.options.agents.startImages(
      {
        project,
        task: texts.jobTitle({ shot: input.shot, frames: frames.map((frame) => frame.id).join(', '), provider: mediaProviderTitle(request.provider) }),
        prompt:
          // eslint-disable-next-line no-restricted-syntax -- Инструкция и формат ответа генератора сохраняются у владельца промпта.
          'Создай перечисленные опорные изображения встроенным инструментом генерации изображений. Используй только переданные копии референсов. ' +
          (approved.length
            ? // eslint-disable-next-line no-restricted-syntax -- Инструкция и формат ответа генератора сохраняются у владельца промпта.
              'approvedFrames — уже утверждённые кадры этого же плана: передай их генератору как референсы и сохрани с ними внешность и одежду героев, свет, место, ' +
              // eslint-disable-next-line no-restricted-syntax -- Инструкция и формат ответа генератора сохраняются у владельца промпта.
              'расстановку и направление транспорта и героев; меняй только то, что задаёт промпт создаваемой опоры. '
            : '') +
          // eslint-disable-next-line no-restricted-syntax -- Инструкция и формат ответа генератора сохраняются у владельца промпта.
          (notes.length ? 'notes — исправления пользователя к прежним вариантам: выполни их, они важнее совпадения с прежним результатом. ' : '') +
          // eslint-disable-next-line no-restricted-syntax -- Инструкция и формат ответа генератора сохраняются у владельца промпта.
          'Сохрани каждый результат как Kxx.png, Kxx.jpg или Kxx.webp в текущей папке, сохраняя фактический формат генератора. Не используй внешние сервисы генерации, API-ключи или другие генераторы. ' +
          // eslint-disable-next-line no-restricted-syntax -- Инструкция и формат ответа генератора сохраняются у владельца промпта.
          'Если встроенный image tool недоступен, сообщи об этом и не подменяй его другим способом. ' +
          // eslint-disable-next-line no-restricted-syntax -- Инструкция и формат ответа генератора сохраняются у владельца промпта.
          'Не изменяй референсы, исходный проект или принятые материалы. ' +
          // eslint-disable-next-line no-restricted-syntax -- Инструкция и формат ответа генератора сохраняются у владельца промпта.
          'Финальный ответ — один JSON без Markdown: {"schemaVersion":1,"stage":"frames","images":[{"id":"K01","path":"K01.png"}]}.',
        context: JSON.stringify({
          stage: 'frames',
          shot: input.shot,
          frames,
          ...(approved.length ? { approvedFrames: approved } : {}),
          ...(notes.length ? { notes } : {})
        })
      },
      directory,
      request.agent
    );
    writeLocalJson(join(directory, 'job.json'), {
      schemaVersion: 1,
      jobId: job.id,
      project,
      provider: request.provider,
      requestSha: request.requestSha,
      ids: frames.map((frame) => frame.id),
      inputs
    } satisfies ImagesRecord);
    return job;
  }

  collect(job: AgentJob, requestSha: string): ProductionFrameCandidate[] {
    if (job.status !== 'completed' || job.exitCode !== 0) throw new Error(texts.jobIncomplete);
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
      if (record.requestSha !== requestSha) throw new Error(texts.jobRequestMismatch);
      // Задание выполнила программа-агент провайдера из записи: её название и показывается в ошибках результата.
      if (
        record.schemaVersion !== 1 ||
        record.project !== job.project ||
        mediaProviderInfo(record.provider, 'image')?.executor !== job.provider ||
        !Array.isArray(record.ids) ||
        !Array.isArray(record.inputs)
      )
        throw new Error(texts.jobRecordCorrupt);
      const title = mediaProviderTitle(record.provider);
      for (const file of record.inputs)
        if (
          !existsSync(file.path) ||
          digest(file.path) !== file.sha256 ||
          !existsSync(join(directory, file.copy)) ||
          digest(join(directory, file.copy)) !== file.sha256
        )
          throw new Error(texts.referencesChanged);
      const response: unknown = JSON.parse(job.result);
      if (!response || typeof response !== 'object' || Array.isArray(response)) throw new Error(texts.fileListMissing({ provider: title }));
      const value = response as Record<string, unknown>;
      if (
        value.schemaVersion !== 1 ||
        value.stage !== 'frames' ||
        Object.keys(value).some((key) => !['schemaVersion', 'stage', 'images'].includes(key)) ||
        !Array.isArray(value.images)
      )
        throw new Error(texts.resultContractInvalid);
      const candidates = value.images.map((candidate: unknown) => {
        if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) throw new Error(texts.frameEntryInvalid);
        const item = candidate as Record<string, unknown>;
        if (typeof item.id !== 'string' || typeof item.path !== 'string' || Object.keys(item).some((key) => key !== 'id' && key !== 'path'))
          throw new Error(texts.framePathInvalid);
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
          throw new Error(texts.frameImageRequired({ frame: item.id }));
        if (!imageExtensionMatches(file)) throw new Error(texts.frameExtensionMismatch({ frame: item.id }));
        return { id: item.id, path: file };
      });
      if (
        candidates.length !== record.ids.length ||
        new Set(candidates.map((item) => item.id)).size !== record.ids.length ||
        candidates.some((item) => !record.ids.includes(item.id))
      )
        throw new Error(texts.framesIncomplete({ provider: title }));
      return record.ids.map((id) => candidates.find((candidate) => candidate.id === id)!);
    }
    throw new Error(texts.workDirectoryUnavailable);
  }

  /** После перезапуска восстанавливаем связь с запросом из существующей записи, не создавая второй журнал. */
  getRequestSha(job: AgentJob): string {
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
      if (record.schemaVersion !== 1 || record.project !== job.project) throw new Error(texts.jobRecordCorrupt);
      if (typeof record.requestSha !== 'string' || !/^[a-f0-9]{64}$/.test(record.requestSha)) throw new Error(texts.requestHashCorrupt);
      return record.requestSha;
    }
    throw new Error(texts.workDirectoryUnavailable);
  }
}
