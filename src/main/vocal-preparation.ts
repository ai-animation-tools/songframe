/** Кэш готовых дорожек вне проекта: отделение и выбор не изменяют разметку или исходники. */
import { randomUUID } from 'node:crypto';
import { closeSync, existsSync, openSync, readSync, readdirSync, statSync } from 'node:fs';
import { dirname, join } from 'node:path';
import definition from '../../tools/song_timing/models.json';
import { VOCAL_MODELS, KNOWN_VOCAL_MODELS, type VocalModelId, type VocalPreparationView, type VocalResult } from '@shared/vocals';
import { SONG_MODEL_ID } from '@shared/song-models';
import type { JobInfo } from '@shared/types';
import { vocalTexts as texts } from '@shared/texts/vocals';
import { modelDirectory } from './media-runtime';
import { sha256File } from './sources';
import { readLocalJson, writeLocalJson } from './local-files';
import type { Jobs } from './jobs';

interface Metadata {
  schemaVersion: number;
  recipeVersion: number;
  sourceSha256: string;
  modelId: VocalModelId;
  modelSha256: string;
  audioSha256: string;
  audioFile: string;
  createdAt: string;
  sampleRate: number;
  channels: number;
  samples: number;
}
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA = /^[0-9a-f]{64}$/;
export function songModelsDirectory(jobs: Jobs): string {
  return join(dirname(modelDirectory(jobs.launcher.options, 'medium')), SONG_MODEL_ID);
}
export function modelFilesInstalled(directory: string, component: string): boolean {
  const files = definition.files.filter((file) => file.component === component);
  return (
    files.length > 0 &&
    files.every((item) => {
      try {
        const file = statSync(join(directory, item.name));
        return file.isFile() && file.size === item.bytes;
      } catch {
        return false;
      }
    })
  );
}
export class VocalPreparation {
  private deleting = new Set<string>();
  private activeResults = new Map<string, number>();
  private running = new Map<string, AbortController>();
  private checked = new Map<string, { size: number; mtime: number; ctime: number; sha: string }>();
  constructor(private readonly getJobs: () => Jobs) {}
  private get jobs(): Jobs {
    return this.getJobs();
  }
  private root(sourceSha: string): string {
    const directory = this.jobs.launcher.options.localDir;
    if (!directory) throw new Error(texts.cacheUnavailable);
    return join(directory, 'vocal-results', sourceSha);
  }
  private source(project: string): { path: string; sha: string } {
    const path = join(project, 'source/track.mp3');
    if (!existsSync(path) || !statSync(path).isFile()) throw new Error(texts.sourceRequired);
    return { path, sha: sha256File(path) };
  }
  private result(sourceSha: string, id: string, full = false): VocalResult {
    if (!ID.test(id)) throw new Error(texts.resultInvalid);
    try {
      const directory = join(this.root(sourceSha), id);
      const data = readLocalJson<Metadata>(join(directory, 'result.json'));
      const model = KNOWN_VOCAL_MODELS.find((item) => item.id === data?.modelId);
      const file = definition.files.find((item) => item.component === model?.id);
      if (
        !data ||
        !model ||
        !file ||
        data.schemaVersion !== 1 ||
        data.recipeVersion !== 1 ||
        data.sourceSha256 !== sourceSha ||
        data.modelSha256 !== file.sha256 ||
        data.sampleRate !== 44100 ||
        data.channels !== 2 ||
        !Number.isSafeInteger(data.samples) ||
        data.samples <= 0 ||
        data.audioFile !== 'vocals.wav' ||
        !SHA.test(data.audioSha256) ||
        typeof data.createdAt !== 'string' ||
        !Number.isFinite(Date.parse(data.createdAt))
      )
        throw new Error(texts.resultInvalid);
      const path = join(directory, 'vocals.wav');
      const stat = statSync(path);
      const header = Buffer.alloc(44);
      const fd = openSync(path, 'r');
      try {
        // Отдельный инструмент пишет канонический PCM WAV без дополнительных chunks.
        if (
          readSync(fd, header, 0, 44, 0) !== 44 ||
          header.toString('ascii', 0, 4) !== 'RIFF' ||
          header.toString('ascii', 8, 16) !== 'WAVEfmt ' ||
          header.readUInt32LE(16) !== 16 ||
          header.readUInt16LE(20) !== 1 ||
          header.readUInt16LE(22) !== 2 ||
          header.readUInt32LE(24) !== 44100 ||
          header.readUInt32LE(28) !== 44100 * 4 ||
          header.readUInt16LE(32) !== 4 ||
          header.readUInt16LE(34) !== 16 ||
          header.toString('ascii', 36, 40) !== 'data' ||
          header.readUInt32LE(40) !== data.samples * 4 ||
          header.readUInt32LE(4) + 8 !== stat.size ||
          stat.size !== 44 + data.samples * 4
        )
          throw new Error(texts.resultInvalid);
      } finally {
        closeSync(fd);
      }
      const previous = this.checked.get(path);
      // Опрос окна не перечитывает большой WAV, пока его метаданные не изменились; перед применением проверяем заново.
      if (full || !previous || previous.size !== stat.size || previous.mtime !== stat.mtimeMs || previous.ctime !== stat.ctimeMs) {
        this.checked.set(path, { size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, sha: sha256File(path) });
      }
      if (this.checked.get(path)?.sha !== data.audioSha256) throw new Error(texts.resultInvalid);
      if (!stat.isFile() || stat.size < 44 + data.samples * 4) throw new Error(texts.resultInvalid);
      return { id, modelId: model.id, modelLabel: model.label, path, sha256: data.audioSha256, createdAt: data.createdAt, duration: data.samples / 44100 };
    } catch {
      throw new Error(texts.resultInvalid);
    }
  }
  view(project: string): VocalPreparationView {
    const models = VOCAL_MODELS.map((model) => ({
      ...model,
      installed: modelFilesInstalled(songModelsDirectory(this.jobs), model.id),
      totalBytes: definition.files.filter((item) => item.component === model.id).reduce((sum, item) => sum + item.bytes, 0)
    }));
    const empty: VocalPreparationView = { sourcePath: null, sourceSha256: null, models, results: [], selectedId: null, problems: [] };
    const path = join(project, 'source/track.mp3');
    if (!existsSync(path)) return empty;
    const source = this.source(project);
    const directory = this.root(source.sha);
    const view = { ...empty, sourcePath: source.path, sourceSha256: source.sha };
    if (existsSync(directory)) {
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isDirectory() || !ID.test(entry.name) || !existsSync(join(directory, entry.name, 'result.json'))) continue;
        try {
          view.results.push(this.result(source.sha, entry.name));
        } catch {
          view.problems.push(texts.resultInvalid);
        }
      }
      view.results.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
      try {
        const selection = readLocalJson<{ selectedId?: string }>(join(directory, 'selection.json'));
        if (typeof selection?.selectedId === 'string' && view.results.some((item) => item.id === selection.selectedId)) view.selectedId = selection.selectedId;
        else if (selection?.selectedId) view.problems.push(texts.selectionInvalid);
      } catch {
        view.problems.push(texts.cacheInvalid);
      }
    }
    view.problems = [...new Set(view.problems)];
    return view;
  }
  select(project: string, id: string): VocalPreparationView {
    const source = this.source(project);
    if (this.deleting.has(source.sha)) throw new Error(texts.deletePending);
    this.result(source.sha, id, true);
    // Выбор публикуется только после полной проверки WAV и повторной сверки исходного трека.
    if (this.source(project).sha !== source.sha) throw new Error(texts.sourceChanged);
    writeLocalJson(join(this.root(source.sha), 'selection.json'), { selectedId: id });
    return this.view(project);
  }
  selected(project: string): string {
    const source = this.source(project);
    if (this.deleting.has(source.sha)) throw new Error(texts.deletePending);
    const selection = readLocalJson<{ selectedId?: string }>(join(this.root(source.sha), 'selection.json'));
    if (!selection?.selectedId) throw new Error(texts.selectRequired);
    this.result(source.sha, selection.selectedId, true);
    return join(this.root(source.sha), selection.selectedId, 'result.json');
  }
  /** Один WAV может использоваться разными проектами с одинаковым MP3.
   * Удерживаем его до завершения Jobs, включая ожидание фактической остановки после отмены. */
  startWithSelected(project: string, start: (path: string) => JobInfo): JobInfo {
    const path = this.selected(project);
    this.activeResults.set(path, (this.activeResults.get(path) ?? 0) + 1);
    const release = (): void => {
      const remaining = (this.activeResults.get(path) ?? 1) - 1;
      if (remaining) this.activeResults.set(path, remaining);
      else this.activeResults.delete(path);
    };
    let jobId: string | undefined;
    const stopWatching = this.jobs.onFinished((job) => {
      if (job.id !== jobId) return;
      release();
      stopWatching();
    });
    try {
      const job = start(path);
      jobId = job.id;
      return job;
    } catch (error) {
      stopWatching();
      release();
      throw error;
    }
  }
  /** Корзина ОС удаляет каталог целиком; отказ операции восстанавливает прежний выбор.
   * Исходники, модели и timing.json не участвуют в удалении локального результата. */
  async delete(project: string, id: string, discard: (path: string) => Promise<void>): Promise<VocalPreparationView> {
    const source = this.source(project);
    if (!ID.test(id)) throw new Error(texts.resultInvalid);
    if (this.deleting.has(source.sha)) throw new Error(texts.deletePending);
    const directory = join(this.root(source.sha), id);
    if (this.activeResults.has(join(directory, 'result.json'))) throw new Error(texts.deleteBusy);
    const active = this.jobs
      .list()
      .some((job) => job.project === project && job.status === 'running' && job.steps.some((step) => ['align_lyrics', 'separate_vocals'].includes(step.tool)));
    if (active) throw new Error(texts.deleteBusy);
    if (!existsSync(directory) || !statSync(directory).isDirectory()) throw new Error(texts.resultInvalid);
    const path = join(this.root(source.sha), 'selection.json');
    const selection = readLocalJson<{ selectedId?: string }>(path);
    const selected = selection?.selectedId === id;
    this.deleting.add(source.sha);
    try {
      // Сначала сбрасываем применение: пока файловая операция ожидается, запуск с этим WAV запрещён.
      if (selected) writeLocalJson(path, { selectedId: null });
      try {
        await discard(directory);
      } catch (error) {
        if (selected) writeLocalJson(path, selection);
        throw error;
      }
      this.checked.delete(join(directory, 'vocals.wav'));
      return this.view(project);
    } finally {
      this.deleting.delete(source.sha);
    }
  }
  private model(id: VocalModelId): (typeof VOCAL_MODELS)[number] {
    const model = VOCAL_MODELS.find((item) => item.id === id);
    if (!model) throw new Error(texts.modelUnknown);
    return model;
  }
  download(id: VocalModelId): JobInfo {
    const model = this.model(id);
    const existing = this.jobs.list().find((job) => job.status === 'running' && job.modelDownload?.model === id);
    if (existing) return existing;
    const controller = new AbortController();
    const directory = songModelsDirectory(this.jobs);
    const job = this.jobs.start(
      'model_download',
      texts.download(model.label),
      null,
      [{ tool: 'download_song_models', args: ['--component', id, '--output', directory] }],
      controller.signal
    );
    job.modelDownload = { model: id, directory };
    this.running.set(job.id, controller);
    return job;
  }
  separate(project: string, id: VocalModelId): JobInfo {
    const model = this.model(id);
    const source = this.source(project);
    if (this.deleting.has(source.sha)) throw new Error(texts.deletePending);
    if (!modelFilesInstalled(songModelsDirectory(this.jobs), id)) throw new Error(texts.modelMissing);
    if (
      this.jobs
        .list()
        .some((job) => job.project === project && job.status === 'running' && job.steps.some((step) => ['align_lyrics', 'separate_vocals'].includes(step.tool)))
    )
      throw new Error(texts.busy);
    const output = join(this.root(source.sha), randomUUID());
    const controller = new AbortController();
    const job = this.jobs.start(
      'tool',
      texts.separation(model.label),
      project,
      [
        {
          tool: 'separate_vocals',
          label: texts.separation(model.label),
          args: ['--model', id, '--models', songModelsDirectory(this.jobs), '--output', output],
          timeoutMs: 90 * 60 * 1000
        }
      ],
      controller.signal
    );
    this.running.set(job.id, controller);
    return job;
  }
  cancel(id: string): JobInfo | null {
    const controller = this.running.get(id);
    const job = this.jobs.get(id);
    if (!controller || !job) return null;
    if (job.status === 'running') controller.abort(texts.cancelled);
    return job;
  }
  shutdown(): void {
    for (const controller of this.running.values()) controller.abort(texts.cancelled);
  }
}
