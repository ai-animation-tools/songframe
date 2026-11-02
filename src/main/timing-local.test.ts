/** Предметные задания используют штатный launcher и сохраняют явный выбор режима без скрытого повтора. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync, truncateSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Jobs } from './jobs';
import type { JobInfo } from '@shared/types';
import definition from '../../tools/song_timing/models.json';
import { TimingLocal } from './timing-local';
import { whisperSetup } from './whisper-setup';

vi.mock('./whisper-setup', () => ({ whisperSetup: vi.fn() }));

let directory: string, project: string, service: TimingLocal;
let jobs: JobInfo[];
const start = vi.fn();
beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'songframe-local-timing-'));
  project = join(directory, 'project');
  mkdirSync(join(project, 'source'), { recursive: true });
  writeFileSync(join(project, 'source/track.mp3'), 'MP3');
  writeFileSync(join(project, 'source/text.md'), '[Куплет]\nПервая строка');
  jobs = [];
  start.mockReset();
  start.mockImplementation((kind, title, project, steps) => {
    const job: JobInfo = {
      id: `job-${jobs.length}`,
      kind,
      title,
      project,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      log: '',
      code: null,
      steps: steps.map((step: { tool: string; label?: string }) => ({ tool: step.tool, label: step.label || step.tool, status: 'running', code: null }))
    };
    jobs.push(job);
    return job;
  });
  const model = {
    launcher: { options: { localDir: join(directory, 'state'), env: { XDG_DATA_HOME: directory } } },
    start,
    onFinished: () => () => undefined,
    list: () => jobs,
    get: (id: string) => jobs.find((job) => job.id === id) ?? null
  } as unknown as Jobs;
  service = new TimingLocal(() => model);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function install(): void {
  const path = service.setup().directory;
  mkdirSync(path, { recursive: true });
  for (const item of definition.files) {
    const file = join(path, item.name);
    writeFileSync(file, '');
    truncateSync(file, item.bytes);
  }
}
it('обычный режим не требует дополнительных моделей', async () => {
  await service.start(project, { model: '/chosen/model', vocals: false });
  expect(start.mock.calls[0][3][0].args).not.toContain('--song-models');
  expect(start.mock.calls[0][3][0].args).toContain('/chosen/model');
});
it('усиленный режим отказывает до запуска без моделей и передаёт явный путь после установки', async () => {
  await expect(service.start(project, { model: '/chosen/model', vocals: true })).rejects.toThrow('модель уточнения границ');
  expect(start).not.toHaveBeenCalled();
  install();
  expect(service.setup().installed).toBe(true);
  vi.spyOn(service.vocals, 'selected').mockReturnValue('/chosen/result.json');
  await service.start(project, { model: '/chosen/model', vocals: true, reset: true, device: 'cpu' });
  expect(start.mock.calls[0][3][0].args).toEqual([
    '--json',
    '--model',
    '/chosen/model',
    '--device',
    'cpu',
    '--song-models',
    service.setup().directory,
    '--vocal-result',
    '/chosen/result.json',
    '--reset'
  ]);
});
it('повторная загрузка и запуск распознавания не дублируют активное задание', async () => {
  const first = service.download();
  expect(service.download().id).toBe(first.id);
  expect(start).toHaveBeenCalledTimes(1);
  await service.start(project, { model: '/model' });
  await expect(service.start(project, { model: '/model' })).rejects.toThrow('уже выполняется');
});
it('отмена прерывает только собственное задание через общий AbortSignal', async () => {
  const job = await service.start(project, { model: '/model' });
  const signal = start.mock.calls[0][4] as AbortSignal;
  expect(signal.aborted).toBe(false);
  service.cancel(job.id);
  expect(signal.aborted).toBe(true);
  expect(String(signal.reason)).toContain('остановлена');
  expect(() => service.cancel('foreign')).toThrow('не найдено');
});
it('модели хранятся вне проекта, shutdown отменяет свои загрузки', () => {
  const job = service.download();
  expect(job.modelDownload?.directory).toBe(join(directory, 'songframe', 'models', 'song-timing-v1'));
  service.shutdown();
  expect((start.mock.calls[0][4] as AbortSignal).aborted).toBe(true);
});

it('не запускает обработку при отсутствующем треке или ошибке формата текста', async () => {
  writeFileSync(join(project, 'source/text.md'), '[Куплет\nПервая строка');
  await expect(service.start(project, { model: '/model' })).rejects.toThrow('Строка 1');
  writeFileSync(join(project, 'source/text.md'), '[Куплет]\nПервая строка');
  rmSync(join(project, 'source/track.mp3'));
  await expect(service.start(project, { model: '/model' })).rejects.toThrow('MP3');
  expect(start).not.toHaveBeenCalled();
});

// Два IPC-запуска могут одновременно ждать диагностику; она не должна обходить защиту от дублей.
it('не создаёт второе задание после одновременной диагностики модели', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  vi.mocked(whisperSetup).mockImplementation(async () => {
    await gate;
    return { recommended: 'medium', directories: { medium: '/recommended/model' } } as Awaited<ReturnType<typeof whisperSetup>>;
  });
  const one = service.start(project, {});
  const two = service.start(project, {});
  const results = Promise.allSettled([one, two]);
  release();
  expect((await results).map((item) => item.status)).toEqual(['fulfilled', 'rejected']);
  expect(start).toHaveBeenCalledTimes(1);
  expect(start.mock.calls[0][3][0].args).toContain('/recommended/model');
});

it('не запускает усиленное распознавание до явного выбора готового вокала', async () => {
  install();
  await expect(service.start(project, { model: '/model', vocals: true })).rejects.toThrow('выберите результат');
  expect(start).not.toHaveBeenCalled();
});
