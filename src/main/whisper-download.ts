/** Загрузка модели использует общий Jobs и встроенный Python; отдельного состояния загрузчика нет. */
import { WHISPER_MODELS } from '@shared/whisper-models';
import type { JobInfo } from '@shared/types';
import { modelDirectory } from './media-runtime';
import type { Jobs } from './jobs';

export function startWhisperDownload(jobs: Jobs, model: string): JobInfo {
  const definition = WHISPER_MODELS.find(({ id }) => id === model);
  if (!definition) throw new Error('Выберите поддерживаемую модель распознавания.');
  // Повторный клик или открытие другого окна возвращает уже выполняющееся задание той же модели.
  const active = jobs.list().find((job) => job.kind === 'model_download' && job.modelDownload?.model === model && job.status === 'running');
  if (active) return active;
  const directory = modelDirectory(jobs.launcher.options, definition.id);
  const job = jobs.start('model_download', `Загрузка модели ${model}`, null, [
    { tool: 'download_whisper_model', args: ['--repository', definition.repository, '--output', directory] }
  ]);
  job.modelDownload = { model: definition.id, directory };
  return job;
}
