/** Проверки локальных результатов защищают исходник и отделяют подготовку от запуска распознавания. */
import { randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, truncateSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import definition from '../../tools/song_timing/models.json';
import type { Jobs } from './jobs';
import type { JobInfo } from '@shared/types';
import type { VocalModelId } from '@shared/vocals';
import { sha256File } from './sources';
import { VocalPreparation, songModelsDirectory } from './vocal-preparation';
import { TimingLocal } from './timing-local';
import { writeLocalJson } from './local-files';
import type * as LocalFiles from './local-files';
vi.mock('./local-files', async (original) => ({ ...(await original<typeof LocalFiles>()), writeLocalJson: vi.fn() }));
let directory: string, project: string, localDir: string, jobs: Jobs, service: VocalPreparation;
let list: JobInfo[];
let finishedListeners: Set<(job: JobInfo, project: string | null) => void>;
const start = vi.fn();
beforeEach(async () => {
  const actual = await vi.importActual<typeof LocalFiles>('./local-files');
  vi.mocked(writeLocalJson).mockImplementation(actual.writeLocalJson);
  directory = mkdtempSync(join(tmpdir(), 'songframe-vocal-cache-'));
  project = join(directory, 'project');
  localDir = join(directory, 'state');
  mkdirSync(join(project, 'source'), { recursive: true });
  writeFileSync(join(project, 'source/track.mp3'), 'original MP3');
  writeFileSync(join(project, 'source/text.md'), '[Куплет]\nСтрока песни');
  mkdirSync(join(project, 'plan/audio'), { recursive: true });
  writeFileSync(join(project, 'plan/audio/timing.json'), 'подтверждённая разметка');
  list = [];
  finishedListeners = new Set();
  start.mockReset();
  start.mockImplementation((kind, title, project, steps) => {
    const job: JobInfo = {
      id: 'job-' + list.length,
      kind,
      title,
      project,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      code: null,
      log: '',
      steps: steps.map((step: { tool: string; label?: string }) => ({ tool: step.tool, label: step.label || step.tool, status: 'running', code: null }))
    };
    list.push(job);
    return job;
  });
  jobs = {
    launcher: { options: { localDir, env: { XDG_DATA_HOME: directory } } },
    start,
    onFinished: (listener: (job: JobInfo, project: string | null) => void) => {
      finishedListeners.add(listener);
      return () => finishedListeners.delete(listener);
    },
    list: () => list,
    get: (id: string) => list.find((job) => job.id === id) || null
  } as unknown as Jobs;
  service = new VocalPreparation(() => jobs);
});
afterEach(() => rmSync(directory, { recursive: true, force: true }));
function install(model: VocalModelId): void {
  const file = definition.files.find((file) => file.component === model)!;
  const path = join(songModelsDirectory(jobs), file.name);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, '');
  truncateSync(path, file.bytes);
}
function result(model: VocalModelId = 'voc-ft', extra: Record<string, unknown> = {}, sourceProject = project) {
  const id = randomUUID(),
    sourceSha = sha256File(join(sourceProject, 'source/track.mp3'));
  const root = join(localDir, 'vocal-results', sourceSha, id);
  mkdirSync(root, { recursive: true });
  const audio = join(root, 'vocals.wav');
  const wav = Buffer.alloc(44 + 44100 * 4);
  wav.write('RIFF', 0);
  wav.writeUInt32LE(wav.length - 8, 4);
  wav.write('WAVEfmt ', 8);
  wav.writeUInt32LE(16, 16);
  wav.writeUInt16LE(1, 20);
  wav.writeUInt16LE(2, 22);
  wav.writeUInt32LE(44100, 24);
  wav.writeUInt32LE(44100 * 4, 28);
  wav.writeUInt16LE(4, 32);
  wav.writeUInt16LE(16, 34);
  wav.write('data', 36);
  wav.writeUInt32LE(44100 * 4, 40);
  writeFileSync(audio, wav);
  const metadata = {
    schemaVersion: 1,
    recipeVersion: 1,
    sourceSha256: sourceSha,
    modelId: model,
    modelSha256: definition.files.find((file) => file.component === model)!.sha256,
    audioSha256: sha256File(audio),
    audioFile: 'vocals.wav',
    createdAt: new Date().toISOString(),
    sampleRate: 44100,
    channels: 2,
    samples: 44100,
    ...extra
  };
  writeFileSync(join(root, 'result.json'), JSON.stringify(metadata));
  return { id, root, audio, metadata };
}
it('просмотр не создаёт папок и предлагает только Voc FT для новых запусков', () => {
  const view = service.view(project);
  expect(view.models.map((model) => model.id)).toEqual(['voc-ft']);
  expect(view.models.every((model) => !model.installed)).toBe(true);
  expect(view.results).toEqual([]);
  expect(view.selectedId).toBeNull();
  expect(existsSync(localDir)).toBe(false);
  expect(() => service.selected(project)).toThrow('выберите результат');
});
it('выбранная модель скачивается отдельно, повтор не создаёт дубль', () => {
  const one = service.download('voc-ft');
  expect(service.download('voc-ft').id).toBe(one.id);
  expect(start.mock.calls[0][3][0].args).toEqual(['--component', 'voc-ft', '--output', songModelsDirectory(jobs)]);
  install('voc-ft');
  expect(service.view(project).models.map((model) => model.installed)).toEqual([true]);
  expect(() => service.download('other' as VocalModelId)).toThrow('Неизвестная');
});
it('выделение запускает только separate_vocals без записи источников и автоматического выбора', () => {
  install('voc-ft');
  const before = readFileSync(join(project, 'plan/audio/timing.json'));
  const job = service.separate(project, 'voc-ft');
  const step = start.mock.calls[0][3][0];
  expect(step.tool).toBe('separate_vocals');
  expect(step.args.slice(0, 4)).toEqual(['--model', 'voc-ft', '--models', songModelsDirectory(jobs)]);
  expect(step.args.at(-1)).toContain(join(localDir, 'vocal-results'));
  expect(service.view(project).selectedId).toBeNull();
  expect(readFileSync(join(project, 'plan/audio/timing.json'))).toEqual(before);
  expect(() => service.separate(project, 'voc-ft')).toThrow();
  service.cancel(job.id);
  expect((start.mock.calls[0][4] as AbortSignal).aborted).toBe(true);
});
it('готовые варианты не выбираются автоматически; выбор переносим и восстанавливается после открытия', () => {
  const first = result(),
    second = result('kim-vocal-1');
  expect(service.view(project).results).toHaveLength(2);
  expect(service.view(project).selectedId).toBeNull();
  service.select(project, second.id);
  expect(new VocalPreparation(() => jobs).view(project).selectedId).toBe(second.id);
  expect(service.selected(project)).toBe(join(second.root, 'result.json'));
  const saved = readFileSync(join(dirname(first.root), 'selection.json'), 'utf8');
  expect(JSON.parse(saved)).toEqual({ selectedId: second.id });
  expect(saved).not.toContain(directory);
});
it('отказ записи выбора и отмена новой попытки сохраняют прежний выбранный WAV', () => {
  const first = result(),
    second = result('kim-vocal-1');
  service.select(project, first.id);
  vi.mocked(writeLocalJson).mockImplementationOnce(() => {
    throw new Error('Нет места');
  });
  expect(() => service.select(project, second.id)).toThrow('Нет места');
  expect(service.view(project).selectedId).toBe(first.id);
  install('voc-ft');
  const job = service.separate(project, 'voc-ft');
  service.cancel(job.id);
  expect(service.view(project).selectedId).toBe(first.id);
  expect(existsSync(first.audio)).toBe(true);
});
it('изменённый WAV исключается из просмотра и не передаётся распознаванию', () => {
  const candidate = result();
  service.select(project, candidate.id);
  const bytes = readFileSync(candidate.audio);
  bytes[100] = 1;
  writeFileSync(candidate.audio, bytes);
  const view = service.view(project);
  expect(view.results).toEqual([]);
  expect(view.selectedId).toBeNull();
  expect(view.problems.length).toBeGreaterThan(0);
  expect(() => service.selected(project)).toThrow('повреждён');
});
it.each([{ recipeVersion: 2 }, { modelSha256: 'wrong' }, { samples: 0 }, { samples: 1 }, { audioFile: 'other.wav' }, { createdAt: 'не дата' }])(
  'отклоняет неверный контракт результата %j',
  (metadata) => {
    const candidate = result('voc-ft', metadata);
    expect(service.view(project).results).toEqual([]);
    expect(() => service.select(project, candidate.id)).toThrow('повреждён');
  }
);
it('замена трека не переносит старый выбор и не удаляет старый кэш', () => {
  const candidate = result();
  service.select(project, candidate.id);
  writeFileSync(join(project, 'source/track.mp3'), 'new audio');
  const view = service.view(project);
  expect(view.results).toEqual([]);
  expect(view.selectedId).toBeNull();
  expect(existsSync(candidate.audio)).toBe(true);
  expect(() => service.select(project, candidate.id)).toThrow('повреждён');
  expect(() => service.selected(project)).toThrow('выберите результат');
});
it('незавершённая новая папка не мешает ранее выбранному результату', () => {
  const candidate = result();
  service.select(project, candidate.id);
  const partial = join(dirname(candidate.root), randomUUID());
  mkdirSync(partial);
  writeFileSync(join(partial, 'vocals.wav'), 'partial');
  expect(service.view(project).results).toHaveLength(1);
  expect(service.view(project).selectedId).toBe(candidate.id);
});

it.each(['kim-vocal-1', 'kim-vocal-2'] as const)('читает прежний %s, но не разрешает его новую загрузку и выделение', (model) => {
  const historical = result(model);
  expect(service.view(project).results[0]).toMatchObject({ id: historical.id, modelId: model });
  service.select(project, historical.id);
  expect(service.selected(project)).toBe(join(historical.root, 'result.json'));
  expect(() => service.download(model)).toThrow('Неизвестная модель');
  expect(() => service.separate(project, model)).toThrow('Неизвестная модель');
  expect(start).not.toHaveBeenCalled();
});

/** Вместо корзины ОС тест переносит только каталог результата в отдельную временную папку. */
function discardToTemporaryTrash(path: string): Promise<void> {
  const trash = join(directory, 'trash');
  mkdirSync(trash, { recursive: true });
  renameSync(path, join(trash, path.split(/[\\/]/).at(-1)!));
  return Promise.resolve();
}

it.each([true, false])('удаляет результат через корзину при selected=%s, сохраняя остальные данные', async (selected) => {
  const removed = result('kim-vocal-1');
  const retained = result();
  service.select(project, selected ? removed.id : retained.id);
  const modelPath = join(songModelsDirectory(jobs), 'vocals.onnx');
  mkdirSync(dirname(modelPath), { recursive: true });
  writeFileSync(modelPath, 'weights fixture');
  const protectedFiles = [
    join(project, 'source/track.mp3'),
    join(project, 'source/text.md'),
    join(project, 'plan/audio/timing.json'),
    modelPath,
    retained.audio,
    join(retained.root, 'result.json')
  ];
  const before = protectedFiles.map((path) => readFileSync(path));
  const discard = vi.fn(async (path: string) => {
    expect(path).toBe(removed.root);
    expect(service.view(project).selectedId).toBe(selected ? null : retained.id);
    expect(service.view(project).problems).toEqual([]);
    await discardToTemporaryTrash(path);
  });
  const view = await service.delete(project, removed.id, discard);
  expect(discard).toHaveBeenCalledTimes(1);
  expect(existsSync(removed.root)).toBe(false);
  expect(readFileSync(join(directory, 'trash', removed.id, 'vocals.wav'))).toEqual(readFileSync(retained.audio));
  expect(view.results.map((item) => item.id)).toEqual([retained.id]);
  expect(view.selectedId).toBe(selected ? null : retained.id);
  expect(view.problems).toEqual([]);
  protectedFiles.forEach((path, index) => expect(readFileSync(path)).toEqual(before[index]));
});

it.each(['Отмена пользователя', 'Ошибка корзины'])('восстанавливает выбор при отказе переноса: %s', async (message) => {
  const candidate = result();
  service.select(project, candidate.id);
  const selection = join(dirname(candidate.root), 'selection.json');
  const previous = readFileSync(selection);
  const discard = vi.fn(async () => {
    expect(JSON.parse(readFileSync(selection, 'utf8'))).toEqual({ selectedId: null });
    throw new Error(message);
  });
  await expect(service.delete(project, candidate.id, discard)).rejects.toThrow(message);
  expect(readFileSync(selection)).toEqual(previous);
  expect(service.selected(project)).toBe(join(candidate.root, 'result.json'));
  expect(existsSync(candidate.audio)).toBe(true);
  expect(service.view(project).problems).toEqual([]);
});

it('отказ сброса выбора не передаёт каталог в корзину и снимает блокировку удаления', async () => {
  const candidate = result();
  service.select(project, candidate.id);
  const discard = vi.fn(discardToTemporaryTrash);
  vi.mocked(writeLocalJson).mockImplementationOnce(() => {
    throw new Error('Нет места');
  });
  await expect(service.delete(project, candidate.id, discard)).rejects.toThrow('Нет места');
  expect(discard).not.toHaveBeenCalled();
  expect(service.selected(project)).toBe(join(candidate.root, 'result.json'));
  expect(existsSync(candidate.audio)).toBe(true);
  await service.delete(project, candidate.id, discard);
  expect(discard).toHaveBeenCalledTimes(1);
});

it.each(['align_lyrics', 'separate_vocals'])('запрещает удаление во время активного %s этого проекта', async (tool) => {
  const candidate = result();
  service.select(project, candidate.id);
  start('tool', 'Текущее задание', project, [{ tool }]);
  const discard = vi.fn(discardToTemporaryTrash);
  await expect(service.delete(project, candidate.id, discard)).rejects.toThrow('используется текущим заданием');
  expect(discard).not.toHaveBeenCalled();
  expect(service.selected(project)).toBe(join(candidate.root, 'result.json'));
  list[0].status = 'done';
  await service.delete(project, candidate.id, discard);
  expect(discard).toHaveBeenCalledTimes(1);
});

it.each(['../source', '../../outside', '/tmp/outside', 'not-an-id', '00000000-0000-0000-0000-000000000000'])(
  'не передаёт посторонний путь в корзину по id %s',
  async (id) => {
    const candidate = result();
    const outside = join(directory, 'outside');
    writeFileSync(outside, 'keep outside');
    const discard = vi.fn(discardToTemporaryTrash);
    await expect(service.delete(project, id, discard)).rejects.toThrow('повреждён');
    expect(discard).not.toHaveBeenCalled();
    expect(readFileSync(outside, 'utf8')).toBe('keep outside');
    expect(existsSync(candidate.audio)).toBe(true);
  }
);

it('блокирует использование, повторный выбор и выделение, пока корзина ожидает завершения', async () => {
  const removed = result();
  const retained = result('kim-vocal-2');
  service.select(project, removed.id);
  install('voc-ft');
  let release!: () => void;
  const pending = new Promise<void>((resolve) => {
    release = resolve;
  });
  const discard = vi.fn(async (path: string) => {
    await pending;
    await discardToTemporaryTrash(path);
  });
  const deletion = service.delete(project, removed.id, discard);
  expect(service.view(project).selectedId).toBeNull();
  expect(() => service.selected(project)).toThrow('удаляется');
  expect(() => service.select(project, retained.id)).toThrow('удаляется');
  expect(() => service.separate(project, 'voc-ft')).toThrow('удаляется');
  await expect(service.delete(project, retained.id, discard)).rejects.toThrow('удаляется');
  expect(start).not.toHaveBeenCalled();
  release();
  await deletion;
  expect(service.select(project, retained.id).selectedId).toBe(retained.id);
  expect(existsSync(retained.audio)).toBe(true);
});

/** Другая папка проекта может ссылаться на тот же общий кэш исходного MP3. */
function otherProject(track = 'original MP3'): string {
  const other = join(directory, 'other-project');
  mkdirSync(join(other, 'source'), { recursive: true });
  writeFileSync(join(other, 'source/track.mp3'), track);
  writeFileSync(join(other, 'source/text.md'), '[Куплет]\nСтрока песни');
  return other;
}

function finish(job: JobInfo, status: 'done' | 'failed' = 'done'): void {
  job.status = status;
  for (const listener of finishedListeners) listener(job, job.project ?? null);
}

it.each(['done', 'failed'] as const)('общий WAV защищён в другом проекте до фактического завершения %s, включая отмену', async (status) => {
  const timing = new TimingLocal(() => jobs);
  service = timing.vocals;
  const candidate = result();
  const other = otherProject();
  service.select(project, candidate.id);
  for (const file of definition.files.filter((file) => file.component === 'alignment')) {
    const path = join(timing.setup().directory, file.name);
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '');
    truncateSync(path, file.bytes);
  }
  const job = await timing.start(other, { vocals: true, model: '/model' });
  expect(start.mock.calls[0][3][0].args).toContain(join(candidate.root, 'result.json'));
  const discard = vi.fn(discardToTemporaryTrash);
  await expect(service.delete(project, candidate.id, discard)).rejects.toThrow('используется текущим заданием');
  timing.cancel(job.id);
  expect((start.mock.calls[0][4] as AbortSignal).aborted).toBe(true);
  // Даже смена MP3 активного проекта не освобождает прежний WAV до закрытия процесса.
  writeFileSync(join(other, 'source/track.mp3'), 'changed during recognition');
  await expect(service.delete(project, candidate.id, discard)).rejects.toThrow('используется текущим заданием');
  expect(discard).not.toHaveBeenCalled();
  expect(service.view(project).selectedId).toBe(candidate.id);
  finish(job, status);
  await service.delete(project, candidate.id, discard);
  expect(discard).toHaveBeenCalledOnce();
  expect(finishedListeners.size).toBe(0);
});

it('использование другого исходника не блокирует удаление свободного результата', async () => {
  const candidate = result();
  const other = otherProject('different MP3');
  const used = result('voc-ft', {}, other);
  service.select(other, used.id);
  service.startWithSelected(other, () => start('tool', 'Разметка', other, [{ tool: 'align_lyrics' }]));
  await service.delete(project, candidate.id, discardToTemporaryTrash);
  expect(existsSync(candidate.root)).toBe(false);
  expect(existsSync(used.audio)).toBe(true);
  expect(service.view(other).selectedId).toBe(used.id);
});

it('ошибка старта снимает удержание общего WAV', async () => {
  const candidate = result();
  const other = otherProject();
  service.select(project, candidate.id);
  expect(() =>
    service.startWithSelected(other, () => {
      throw new Error('Python недоступен');
    })
  ).toThrow('Python недоступен');
  expect(finishedListeners.size).toBe(0);
  await service.delete(project, candidate.id, discardToTemporaryTrash);
  expect(existsSync(candidate.root)).toBe(false);
});

it('завершение одного из двух заданий не освобождает общий WAV второго задания', async () => {
  const candidate = result();
  const other = otherProject();
  service.select(project, candidate.id);
  const first = service.startWithSelected(other, () => start('tool', 'Первая разметка', other, [{ tool: 'align_lyrics' }]));
  const second = service.startWithSelected(other, () => start('tool', 'Вторая разметка', other, [{ tool: 'align_lyrics' }]));
  finish(first);
  await expect(service.delete(project, candidate.id, discardToTemporaryTrash)).rejects.toThrow('используется текущим заданием');
  finish(second);
  await service.delete(project, candidate.id, discardToTemporaryTrash);
  expect(existsSync(candidate.root)).toBe(false);
  expect(finishedListeners.size).toBe(0);
});
