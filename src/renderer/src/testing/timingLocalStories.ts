/** Локальные задания разметки и установки моделей; сохранённый снимок меняется только по успешному done. */
import type { JobInfo, TimingGenerateOptions, TimingView } from '@shared/types';
import { storyFileUrl, type ApiOverrides } from './storybook';
import { songTimingTexts as texts } from '@shared/texts/song-timing';
import type { VocalModelId } from '@shared/vocals';
import { makeVocalStoryView, addVocalStoryResult, syntheticVocalAudio } from './vocalStories';
import { WHISPER_MODELS, type WhisperSetup } from '@shared/whisper-models';

export type TimingLocalVariant =
  | 'vocal-cancel-pending'
  | 'vocal-cached'
  | 'vocal-delete-failure'
  | 'vocal-delete-in-use'
  | 'whisper-download'
  | 'whisper-files-missing'
  | 'whisper-custom-ready'
  | 'vocal-download'
  | 'vocal-download-failure'
  | 'vocal-failure'
  | 'vocal-running'
  | 'vocal-stale'
  | 'vocal-old-api'
  | 'installed'
  | 'download'
  | 'failure'
  | 'running'
  | 'partial'
  | 'old-api'
  | 'cancel-error'
  | 'download-failure'
  | 'reload-failure'
  | 'start-failure'
  | 'delayed-start'
  | 'setup-failure'
  | 'missing-job';
interface Inspection {
  starts: TimingGenerateOptions[];
  downloads: number;
  cancels: number;
  separations: VocalModelId[];
  vocalDownloads: VocalModelId[];
  selections: string[];
  deletions: string[];
  whisperDownloads: string[];
}
let nextLocalSession = 0;
let installCustomWhisper: (() => void) | null = null;
export function installCustomWhisperStoryModel(): void {
  installCustomWhisper?.();
}
let changeSource: (() => void) | null = null;
let failNextRead: (() => void) | null = null;
export function failNextVocalStoryRead(): void {
  failNextRead?.();
}
export function changeVocalStorySource(): void {
  changeSource?.();
}
let inspect: (() => Inspection) | null = null;
export function timingLocalInspection(): Inspection {
  if (!inspect) throw new Error('Модель локальной разметки не открыта.');
  return inspect();
}
export function createTimingLocalModel(variant: TimingLocalVariant, read: () => TimingView, save: (view: TimingView) => void) {
  const project = '/mock/timing-project';
  const sessionId = ++nextLocalSession;
  const calls: Inspection = { starts: [], downloads: 0, cancels: 0, separations: [], vocalDownloads: [], selections: [], deletions: [], whisperDownloads: [] };
  const vocals = makeVocalStoryView(
    !['vocal-download', 'vocal-download-failure'].includes(variant),
    ['vocal-cached', 'vocal-failure', 'vocal-stale', 'vocal-delete-failure', 'vocal-delete-in-use'].includes(variant)
  );
  changeSource = () => {
    vocals.sourceSha256 = 'changed-original-sha';
    vocals.results = [];
    vocals.selectedId = null;
  };
  let failRead = false;
  failNextRead = () => {
    failRead = true;
  };
  const preparationModels = new Map<string, VocalModelId>();
  const jobs: JobInfo[] = [];
  const polls = new Map<string, number>();
  const cancelling = new Map<string, number>();
  let installed = !['download', 'cancel-error', 'download-failure', 'setup-failure', 'vocal-cancel-pending'].includes(variant);
  let setupReads = 0;
  let customWhisperInstalled = variant === 'whisper-custom-ready';
  installCustomWhisper = () => {
    customWhisperInstalled = true;
  };
  const snapshot = (): Inspection => structuredClone(calls);
  inspect = snapshot;
  const makeJob = (download = false): JobInfo => {
    const job: JobInfo = {
      id: `local-${sessionId}-${jobs.length}`,
      kind: download ? 'model_download' : 'tool',
      title: download ? texts.download : texts.jobTitle,
      project: download ? null : project,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      log: `${download ? 'alignment.onnx: 25%' : 'Уточнение границ: 1/3'}\n{"status":"running","internal":"diagnostic-only"}`,
      code: null,
      steps: [{ tool: download ? 'download_song_models' : 'align_lyrics', label: download ? texts.download : texts.vocals, status: 'running', code: null }],
      ...(download ? { modelDownload: { model: 'song-timing-v1', directory: '/mock/models/song-timing-v1' } } : {})
    };
    jobs.unshift(job);
    polls.set(job.id, 0);
    return structuredClone(job);
  };
  const setup: WhisperSetup = {
    hardware: {
      cpuName: 'CPU витрины',
      cpuThreads: 8,
      ramGiB: 16,
      gpuName: null,
      vramMiB: 0,
      cudaReady: false,
      device: 'cpu',
      computeType: 'int8',
      reason: 'CPU'
    },
    recommended: 'medium',
    recommendation: 'Модель установлена в локальном окружении витрины.',
    gpuSuggestion: null,
    platform: 'linux',
    directories: Object.fromEntries(WHISPER_MODELS.map((model) => [model.id, `/mock/whisper-${model.id}`])) as WhisperSetup['directories'],
    installed: { small: true, medium: !['whisper-download', 'whisper-files-missing'].includes(variant), 'large-v3-turbo': true, 'large-v3': true }
  };
  const makePreparationJob = (model: VocalModelId, download: boolean): JobInfo => {
    const job = makeJob(download);
    const stored = jobs.find((value) => value.id === job.id)!;
    stored.title = download ? texts.downloadVocal : texts.separateVocal;
    stored.steps[0].tool = download ? 'download_song_models' : 'separate_vocals';
    stored.log = `${download ? `${model}: 25%` : 'Выделение вокала: 1/3'}\n{"status":"running","internal":"diagnostic-only"}`;
    if (download) stored.modelDownload = { model, directory: '/mock/models/song-timing-v1' };
    preparationModels.set(stored.id, model);
    return structuredClone(stored);
  };
  const originalAudio = syntheticVocalAudio(false),
    vocalAudio = syntheticVocalAudio(true);
  const api: ApiOverrides = {
    shell: { fileUrl: (path) => (path === vocals.sourcePath ? originalAudio : path.startsWith('/mock/vocal-result-') ? vocalAudio : storyFileUrl(path)) },
    timing: {
      vocalsView: async () => {
        if (failRead) {
          failRead = false;
          throw new Error('Не удалось проверить готовый вокал. Повторяем чтение.');
        }
        return structuredClone(vocals);
      },
      downloadVocalModel: async (model) => {
        calls.vocalDownloads.push(model);
        return makePreparationJob(model, true);
      },
      separateVocals: async (_project, model) => {
        calls.separations.push(model);
        return makePreparationJob(model, false);
      },
      selectVocal: async (_project, id) => {
        calls.selections.push(id);
        if (!vocals.results.some((result) => result.id === id)) throw new Error('Исходный трек изменился. Выделите вокал заново.');
        vocals.selectedId = id;
        return structuredClone(vocals);
      },
      deleteVocal: async (_project, id) => {
        calls.deletions.push(id);
        if (variant === 'vocal-delete-in-use') throw new Error(texts.vocalInUse);
        if (variant === 'vocal-delete-failure' && calls.deletions.length === 1) throw new Error('Не удалось удалить WAV. Готовый вокал и выбор сохранены.');
        if (jobs.some((job) => job.status === 'running' && !job.modelDownload && !preparationModels.has(job.id))) throw new Error(texts.vocalInUse);
        vocals.results = vocals.results.filter((result) => result.id !== id);
        if (vocals.selectedId === id) vocals.selectedId = null;
        return structuredClone(vocals);
      },
      modelSetup: async () => structuredClone(setup),
      inspectModel: async (path) => {
        const model = WHISPER_MODELS.find((item) => setup.directories[item.id] === path)?.id;
        const installed = model ? setup.installed[model] : path === '/mock/custom-whisper-model' && customWhisperInstalled;
        return { installed, missing: installed ? [] : ['model.bin', 'config.json', 'tokenizer.json'] };
      },
      downloadModel: async (model) => {
        calls.whisperDownloads.push(model);
        const job = makeJob(true);
        const stored = jobs.find((value) => value.id === job.id)!;
        stored.modelDownload = { model, directory: setup.directories[model] };
        stored.log = `${model}: 25%\n{"internal":"diagnostic-only"}`;
        return structuredClone(stored);
      },
      songModelSetup: async () => {
        if (variant === 'setup-failure' && setupReads++ === 0) throw new Error('Не удалось проверить файлы моделей. Повторите чтение.');
        return { directory: '/mock/models/song-timing-v1', installed, totalBytes: 317524664 };
      },
      downloadSongModels: async () => {
        calls.downloads++;
        return makeJob(true);
      },
      start: async (_project, options) => {
        if (options.vocals && !vocals.selectedId) throw new Error(texts.vocalSelectRequired);
        calls.starts.push(structuredClone(options));
        if (variant === 'start-failure' && calls.starts.length === 1) throw new Error('Не удалось запустить разметку. Повторите запуск.');
        if (variant === 'delayed-start') await new Promise((resolve) => setTimeout(resolve, 600));
        return makeJob();
      },
      cancel: async (id) => {
        calls.cancels++;
        if (variant === 'cancel-error' && calls.cancels === 1) throw new Error('Не удалось остановить обработку. Повторите отмену.');
        const job = jobs.find((value) => value.id === id);
        if (!job) throw new Error(texts.noJob);
        if (variant === 'vocal-cancel-pending') {
          cancelling.set(id, 0);
          return structuredClone(job);
        }
        job.status = 'failed';
        job.error = preparationModels.has(id) ? texts.vocalStopped : texts.cancelled;
        return structuredClone(job);
      }
    },
    jobs: {
      list: async () => structuredClone(jobs),
      get: async (id) => {
        const job = jobs.find((value) => value.id === id);
        if (!job) return null;
        if (cancelling.has(id)) {
          const remaining = (cancelling.get(id) ?? 0) + 1;
          cancelling.set(id, remaining);
          if (remaining >= 2) {
            job.status = 'failed';
            job.error = preparationModels.has(id) ? texts.vocalStopped : texts.cancelled;
            cancelling.delete(id);
          }
          return structuredClone(job);
        }
        const count = (polls.get(id) ?? 0) + 1;
        polls.set(id, count);
        if (variant === 'missing-job' && !job.modelDownload && calls.starts.length === 1) {
          jobs.splice(jobs.indexOf(job), 1);
          return null;
        }
        if (preparationModels.has(id)) {
          if (job.status === 'running' && count >= 2 && !['vocal-running', 'vocal-cancel-pending'].includes(variant)) {
            if (
              (variant === 'vocal-failure' && !job.modelDownload && calls.separations.length === 1) ||
              (variant === 'vocal-download-failure' && job.modelDownload && calls.vocalDownloads.length === 1)
            ) {
              job.status = 'failed';
              job.error = job.modelDownload
                ? 'Загрузка вокальной модели прервана. Повторите загрузку.'
                : 'Выделение не удалось. Готовые варианты и выбор сохранены.';
            } else {
              job.status = 'done';
              job.code = 0;
              job.log += '\nГотово';
              const model = preparationModels.get(id)!;
              if (job.modelDownload) vocals.models.find((item) => item.id === model)!.installed = true;
              else addVocalStoryResult(vocals, model);
            }
            job.finishedAt = new Date().toISOString();
          }
          return structuredClone(job);
        }
        if (job.status === 'running' && count >= 2 && !['running', 'cancel-error', 'vocal-cancel-pending'].includes(variant)) {
          if (
            (variant === 'failure' && !job.modelDownload && calls.starts.length === 1) ||
            (variant === 'download-failure' && !!job.modelDownload && calls.downloads === 1)
          ) {
            job.status = 'failed';
            job.error = job.modelDownload
              ? 'Загрузка прервана. Повторите загрузку для продолжения.'
              : 'Не удалось уточнить границы. Прежняя разметка сохранена.';
          } else {
            job.status = 'done';
            job.code = 0;
            job.log += '\nГотово';
            if (job.modelDownload) {
              const whisperModel = WHISPER_MODELS.find((model) => model.id === job.modelDownload?.model)?.id;
              if (whisperModel && variant !== 'whisper-files-missing') setup.installed[whisperModel] = true;
              else if (!whisperModel) installed = true;
            } else {
              const value = structuredClone(read());
              value.timing!.lines = value
                .timing!.lines.filter((line) => variant !== 'partial' || line.source_line !== 2)
                .map((line, index) => ({
                  ...line,
                  id: index + 1,
                  ...(line.verified ? {} : line.source_line === 2 ? { start: 12, end: 16 } : { start: 20, end: 23 })
                }));
              value.timing!.status = variant === 'partial' ? 'Не найдено строк: 1; укажите их границы вручную.' : texts.ready;
              save(value);
            }
          }
          job.finishedAt = new Date().toISOString();
        }
        return structuredClone(job);
      }
    }
  };
  if (variant === 'vocal-cancel-pending') {
    makePreparationJob('voc-ft', false);
    makeJob(true);
  }
  return {
    api,
    cleanup: () => {
      if (inspect === snapshot) {
        inspect = null;
        changeSource = null;
        failNextRead = null;
        installCustomWhisper = null;
      }
    }
  };
}
