/** Проверяем жизненный цикл на настоящем пакете; сквозная проверка размера использует FFmpeg, модель всегда подставная. */
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentCheckResult, AgentJob, AgentStartInput } from '@shared/agents';
import type { ScenesFile, ToolResult } from '@shared/types';
import type { VideoReviewReport, VideoReviewView } from '@shared/video-review';
import { AGENT_PROVIDERS } from '@shared/agent-providers';
import { videoReviewTexts } from '@shared/texts/video-review';
import { AgentManager } from './agent-manager';
import { CodexAdapter } from './agent-adapters';
import { SettingsStore } from './settings';
import { PythonLauncher } from './python-launcher';
import { readPackage } from './production';
import { parseVideoReviewReport, VideoReview } from './video-review';

const texts = videoReviewTexts.main;
const sample = resolve('tools/testdata/sample-project');
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM6sAAAAASUVORK5CYII=', 'base64');
let project: string;
let directory: string;
let original: string;
let references: string[];
let reviews: VideoReview[];
let release: (() => void) | undefined;
let gate: Promise<void> | undefined;
let jobs: Map<string, AgentJob>;
let agents: Pick<AgentManager, 'start' | 'get' | 'list' | 'cancel'>;
let launcher: Pick<PythonLauncher, 'run' | 'available'>;

const result = (value: unknown): ToolResult => ({ code: 0, stdout: JSON.stringify(value), stderr: '', command: 'Подставной инструмент' });
function report(): VideoReviewReport {
  return {
    schemaVersion: 1,
    summary: 'Лодка видна у причала.',
    findings: [{ verdict: 'match', timeSeconds: 0.5, description: 'Лодка остаётся у причала.', frameIds: ['F002'] }],
    limitations: ['Проверена выборка кадров; звук и движение между ними не оценены.']
  };
}
function blockPreparation(): void {
  gate = new Promise<void>((done) => {
    release = done;
  });
}
function create(imageBudgetBytes?: number): VideoReview {
  const review = new VideoReview({
    agents,
    launcher: () => launcher,
    toolsRoot: () => resolve('.'),
    isPackageBusy: () => false,
    ...(imageBudgetBytes === undefined ? {} : { imageBudgetBytes: () => imageBudgetBytes })
  });
  reviews.push(review);
  return review;
}
function latest(): string {
  return join(directory, 'video-review/latest.json');
}
function changeJson(path: string, update: (value: Record<string, unknown>) => void): void {
  const value = JSON.parse(readFileSync(path, 'utf8')) as Record<string, unknown>;
  update(value);
  writeFileSync(path, JSON.stringify(value));
}
async function state(review: VideoReview, status: VideoReviewView['status']): Promise<VideoReviewView> {
  await vi.waitFor(() => expect(review.view(project, directory).status).toBe(status));
  return review.view(project, directory);
}
async function running(review: VideoReview): Promise<VideoReviewView> {
  expect(await review.start(project, directory)).toMatchObject({ status: 'preparing', canStart: false });
  return state(review, 'running');
}
async function completed(review: VideoReview): Promise<VideoReviewView> {
  const view = await running(review);
  const job = jobs.get(view.job!.id)!;
  job.status = 'completed';
  job.result = JSON.stringify(report());
  return state(review, 'completed');
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-video-review-'));
  mkdirSync(join(project, 'plan'), { recursive: true });
  for (const name of ['scenes.json', 'cast.json', 'project.json']) copyFileSync(join(sample, 'plan', name), join(project, 'plan', name));
  directory = join(project, 'plan/batches/review-M01');
  const request = join(directory, 'requests/one');
  mkdirSync(request, { recursive: true });
  original = join(request, 'original.mp4');
  writeFileSync(original, 'Локальные байты оригинала; декодирование заменено подставным инструментом.');
  references = [join(directory, 'K01.png'), join(directory, 'K02.png')];
  for (const path of references) writeFileSync(path, png);
  writeFileSync(join(directory, 'description.md'), 'Лодка у причала.');
  writeFileSync(join(directory, 'video-prompt.txt'), 'Редактируемый черновик, который уже отличается.');
  writeFileSync(join(request, 'prompt.txt'), 'Замороженный промпт: лодка у причала.');
  writeFileSync(
    join(request, 'request.json'),
    JSON.stringify({ provider: 'test', kind: 'video', model: 'test', prompt: 'prompt.txt', parameters: {}, inputs: [] })
  );
  writeFileSync(join(request, 'attempt.json'), JSON.stringify({ status: 'downloaded', request_sha256: 'a'.repeat(64), downloads: [{ path: 'original.mp4' }] }));
  writeFileSync(
    join(directory, 'workflow.json'),
    JSON.stringify({
      schema_version: 1,
      shot: 'M01',
      stage: 'downloaded',
      request_dir: 'requests/one',
      keyframes: [
        { id: 'K01', role: 'first', time_seconds: 0, path: 'K01.png', approved: true },
        { id: 'K02', role: 'last', time_seconds: 1, path: 'K02.png', approved: true }
      ]
    })
  );
  reviews = [];
  jobs = new Map();
  gate = undefined;
  release = undefined;
  agents = {
    start: vi.fn((input: unknown) => {
      const value = input as AgentStartInput;
      const job: AgentJob = {
        schemaVersion: 1,
        id: `job-${jobs.size + 1}`,
        sequence: 1,
        project: value.project,
        provider: 'codex',
        task: value.task,
        permissions: 'read-only',
        inputHashes: { prompt: '', context: '' },
        status: 'running',
        phase: 'Проверка',
        startedAt: new Date().toISOString(),
        finishedAt: null,
        exitCode: null,
        result: '',
        log: ''
      };
      jobs.set(job.id, job);
      return structuredClone(job);
    }),
    get: vi.fn((id: string) => structuredClone(jobs.get(id) ?? null)),
    list: vi.fn((selected?: string) => [...jobs.values()].filter((job) => !selected || job.project === selected).map((job) => structuredClone(job))),
    cancel: vi.fn((id: string) => {
      const job = jobs.get(id)!;
      job.status = 'cancelled';
      return structuredClone(job);
    })
  };
  launcher = {
    available: () => true,
    run: vi.fn<PythonLauncher['run']>(async (_project, name, args) => {
      if (name === 'continuity_brief') return result({ phase: args[args.indexOf('--phase') + 1], entities: {} });
      if (name !== 'video_review') throw new Error(`Неожиданный инструмент ${name}`);
      if (gate) await gate;
      const out = args[args.indexOf('--out') + 1];
      mkdirSync(out, { recursive: true });
      const frames = [0, 0.5, 0.9].map((time, index) => {
        const id = `F${String(index + 1).padStart(3, '0')}`;
        const path = join(out, `${id}.png`);
        writeFileSync(path, Buffer.concat([png, Buffer.from(id)]));
        return { id, time_seconds: time, path };
      });
      const refs = references.map((source, index) => {
        const id = `R${String(index + 1).padStart(3, '0')}`;
        const path = join(out, `${id}.png`);
        copyFileSync(source, path);
        return { id, source_path: source, path };
      });
      return result({ schema_version: 1, duration_seconds: 1, frames, references: refs });
    })
  };
});
afterEach(async () => {
  release?.();
  await Promise.all(reviews.map((review) => review.shutdown()));
  vi.restoreAllMocks();
  rmSync(project, { recursive: true, force: true });
});

describe('Отчёт проверки видео', () => {
  const frames = [
    { id: 'F001', timeSeconds: 0, path: '/tmp/F001.png' },
    { id: 'F002', timeSeconds: 0.5, path: '/tmp/F002.png' }
  ];
  it('принимает наблюдение только со свидетельством из реально показанной выборки', () => {
    expect(parseVideoReviewReport(JSON.stringify(report()), frames, 1)).toEqual(report());
    for (const finding of [
      { ...report().findings[0], frameIds: ['F999'] },
      { ...report().findings[0], timeSeconds: 0.25 },
      { ...report().findings[0], timeSeconds: 1 },
      { ...report().findings[0], frameIds: [] },
      { ...report().findings[0], accept: true }
    ])
      expect(() => parseVideoReviewReport({ ...report(), findings: [finding] }, frames, 1)).toThrow(texts.invalidReport);
    expect(() => parseVideoReviewReport({ ...report(), accept: true }, frames, 1)).toThrow(texts.invalidReport);
  });
});

describe('Проверка видео в настоящем пакете', () => {
  it('передаёт бюджет выбранного CLI в подготовку, сохраняя все изображения', async () => {
    const budget = AGENT_PROVIDERS.claude.reviewImageBudgetBytes;
    await running(create(budget));
    const call = vi.mocked(launcher.run).mock.calls.find((call) => call[1] === 'video_review')!;
    expect(call[2][call[2].indexOf('--image-budget-bytes') + 1]).toBe(String(budget));
    expect((vi.mocked(agents.start).mock.calls[0][0] as AgentStartInput).images).toHaveLength(5);
  });

  it('передаёт реальные кадры и опоры в порядке контекста, сохраняет отчёт и оставляет приёмку пользователю', async () => {
    const workflow = readFileSync(join(directory, 'workflow.json'));
    const sourceVideo = readFileSync(original);
    const refs = references.map((path) => readFileSync(path));
    expect(readPackage(project, directory)?.resultToken).toMatch(/^[a-f0-9]{64}$/);
    const review = create();
    const view = await completed(review);
    expect(view).toMatchObject({ status: 'completed', stale: false, canStart: true, report: report(), durationSeconds: 1 });
    const input = vi.mocked(agents.start).mock.calls[0][0] as AgentStartInput;
    expect(input.images?.map((path) => basename(path))).toEqual(['F001.png', 'F002.png', 'F003.png', 'R001.png', 'R002.png']);
    expect(input.images?.every((path) => existsSync(path))).toBe(true);
    expect(input.images?.slice(3).map((path) => readFileSync(path))).toEqual(refs);
    const context = JSON.parse(input.context!);
    expect(context.frames).toEqual([
      { id: 'F001', timeSeconds: 0 },
      { id: 'F002', timeSeconds: 0.5 },
      { id: 'F003', timeSeconds: 0.9 }
    ]);
    expect(context.references).toEqual([
      { id: 'R001', keyframeId: 'K01', role: 'first', timeSeconds: 0 },
      { id: 'R002', keyframeId: 'K02', role: 'last', timeSeconds: 1 }
    ]);
    expect(context.staging.videoPrompt).toBe('Замороженный промпт: лодка у причала.');
    expect(context.staging.sequence).toMatchObject({ id: 'intro', direction: 'Общий план причала, спокойный темп.' });
    expect(context.briefs).toMatchObject({ before: { phase: 'before' }, after: { phase: 'after' } });
    expect(readFileSync(join(directory, 'workflow.json'))).toEqual(workflow);
    expect(readFileSync(original)).toEqual(sourceVideo);
    expect(references.map((path) => readFileSync(path))).toEqual(refs);
    expect(existsSync(join(project, 'assets/shots/M01/manifest.json'))).toBe(false);
    expect(create().view(project, directory)).toMatchObject({ status: 'completed', stale: false, report: report() });
    expect(agents.start).toHaveBeenCalledTimes(1);
  });

  it.each(['original', 'reference', 'scenario', 'cast', 'frame', 'prepared-reference'] as const)(
    'помечает отчёт устаревшим после изменения %s',
    async (source) => {
      const review = create();
      const done = await completed(review);
      if (source === 'original') writeFileSync(original, 'Другой оригинал');
      else if (source === 'reference') writeFileSync(references[0], Buffer.concat([png, Buffer.from('Новая опора')]));
      else if (source === 'scenario')
        changeJson(join(project, 'plan/scenes.json'), (value) => {
          (value.scenes as ScenesFile['scenes'])[0].action = 'Лодка уходит от причала.';
        });
      else if (source === 'cast')
        changeJson(join(project, 'plan/cast.json'), (value) => {
          (value.entities as Array<Record<string, unknown>>)[0].appearance = 'Новый облик';
        });
      else if (source === 'frame') writeFileSync(done.frames[0].path, Buffer.concat([png, Buffer.from('Другой кадр')]));
      else {
        const input = vi.mocked(agents.start).mock.calls[0][0] as AgentStartInput;
        writeFileSync(input.images![3], Buffer.concat([png, Buffer.from('Другая подготовленная опора')]));
      }
      expect(review.view(project, directory)).toMatchObject({ status: 'completed', stale: true, report: report() });
      expect(agents.start).toHaveBeenCalledTimes(1);
    }
  );

  it('не запускает второй анализ по повторному клику и не смешивает изменившийся оригинал с подготовленными кадрами', async () => {
    blockPreparation();
    const review = create();
    const other = join(project, 'plan/batches/другой-пакет');
    cpSync(directory, other, { recursive: true });
    await review.start(project, directory);
    expect(review.view(project, other)).toMatchObject({ canStart: false, reason: texts.busy });
    await expect(review.start(project, directory)).rejects.toThrow(texts.busy);
    writeFileSync(original, 'Оригинал заменён во время извлечения');
    release!();
    expect(await state(review, 'failed')).toMatchObject({ error: texts.sourceChanged, canStart: true });
    expect(agents.start).not.toHaveBeenCalled();
    expect(launcher.run).toHaveBeenCalledTimes(3);
  });

  it('отменяет подготовку до запуска агента и допускает отдельную новую проверку после завершения инструмента', async () => {
    blockPreparation();
    const review = create();
    await review.start(project, directory);
    expect(await review.cancel(project, directory)).toMatchObject({ status: 'cancelled', report: null, canStart: false });
    release!();
    await review.shutdown();
    gate = undefined;
    expect(agents.start).not.toHaveBeenCalled();
    await running(review);
    expect(agents.start).toHaveBeenCalledTimes(1);
  });

  it('отмена анализа вызывает менеджер и оставляет отчёт без результата', async () => {
    const review = create();
    const view = await running(review);
    expect(await review.cancel(project, directory)).toMatchObject({ status: 'cancelled', report: null, error: texts.cancelled });
    expect(agents.cancel).toHaveBeenCalledWith(view.job!.id);
  });

  it('ошибки инструмента, агента и неверный JSON не становятся готовым отчётом', async () => {
    const review = create();
    vi.mocked(launcher.run).mockResolvedValueOnce({ code: 1, stdout: '', stderr: 'Не удалось прочитать видео.', command: 'Подставной инструмент' });
    await review.start(project, directory);
    expect(await state(review, 'failed')).toMatchObject({ error: 'Не удалось прочитать видео.', report: null });
    expect(agents.start).not.toHaveBeenCalled();
    let view = await running(review);
    jobs.get(view.job!.id)!.status = 'failed';
    jobs.get(view.job!.id)!.message = 'Лимит агента';
    expect(await state(review, 'failed')).toMatchObject({ error: 'Лимит агента', report: null });
    view = await running(review);
    jobs.get(view.job!.id)!.status = 'completed';
    jobs.get(view.job!.id)!.result = 'Ответ без JSON';
    expect(await state(review, 'failed')).toMatchObject({ error: texts.invalidReport, report: null });
  });

  it('не доверяет сохранённому отчёту без хеша кадра-свидетельства', async () => {
    const review = create();
    await completed(review);
    changeJson(latest(), (value) => {
      const frame = (value.frames as Array<{ path: string }>)[0];
      delete (value.imageHashes as Record<string, unknown>)[frame.path];
    });
    expect(review.view(project, directory)).toMatchObject({ status: 'failed', stale: true, report: null, error: texts.invalidReport });
  });

  it('отклоняет выход инструмента с кадром вне папки подготовленной выборки', async () => {
    const review = create();
    const run = vi.mocked(launcher.run).getMockImplementation()!;
    vi.mocked(launcher.run).mockImplementationOnce(async (...args) => {
      const output = await run(...args);
      const manifest = JSON.parse(output.stdout);
      manifest.frames[0].path = original;
      return result(manifest);
    });
    await review.start(project, directory);
    expect(await state(review, 'failed')).toMatchObject({ report: null });
    expect(agents.start).not.toHaveBeenCalled();
  });

  it('после перезапуска отмечает незавершённую подготовку и потерянное задание без автоматической отправки', async () => {
    const review = create();
    await completed(review);
    const saved = readFileSync(latest(), 'utf8');
    changeJson(latest(), (value) => {
      value.status = 'preparing';
      value.report = null;
      value.jobId = null;
      value.frames = [];
      value.durationSeconds = null;
      value.imageHashes = {};
    });
    expect(create().view(project, directory)).toMatchObject({ status: 'failed', error: texts.interrupted });
    writeFileSync(latest(), saved);
    changeJson(latest(), (value) => {
      value.status = 'running';
      value.report = null;
      value.jobId = 'потерянное-задание';
    });
    expect(create().view(project, directory)).toMatchObject({ status: 'failed', error: texts.interrupted });
    expect(agents.start).toHaveBeenCalledTimes(1);
  });
});

it.skipIf(process.platform === 'win32')(
  'детализированная выборка превышает прежние 20 МиБ PNG, но проходит настоящий транспорт после ограничения размера',
  async () => {
    const native = new PythonLauncher({ toolsRoot: resolve('.'), localDir: join(project, 'local') });
    const baseline = join(project, 'decoded-first.png');
    // Один воспроизводимый шумовой кадр даёт большой PNG без тяжёлой видеофикстуры в репозитории.
    // Lossless-кодирование сохраняет детали: старый набор из 21 кадра и двух опор действительно превышает 20 МиБ.
    const fixture = await native.execute(
      [
        '-c',
        `
import json, random, shutil, subprocess, sys
from pathlib import Path
from PIL import Image
first, last, video, baseline = map(Path, sys.argv[1:])
image = Image.frombytes("RGB", (960, 540), random.Random(104729).randbytes(960 * 540 * 3))
image.save(first, format="PNG")
image.save(last, format="PNG")
ffmpeg = shutil.which("ffmpeg")
subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-loop", "1", "-framerate", "2", "-i", str(first), "-frames:v", "21", "-c:v", "libx264rgb", "-crf", "0", "-preset", "ultrafast", "-threads", "1", "-an", str(video)], check=True)
subprocess.run([ffmpeg, "-hide_banner", "-loglevel", "error", "-y", "-i", str(video), "-frames:v", "1", "-threads", "1", str(baseline)], check=True)
print(json.dumps({"legacyBytes": baseline.stat().st_size * 21 + first.stat().st_size + last.stat().st_size}))
`,
        references[0],
        references[1],
        original,
        baseline
      ],
      { timeoutMs: 30000 },
      project
    );
    expect(fixture.code, fixture.stderr).toBe(0);
    expect(JSON.parse(fixture.stdout).legacyBytes).toBeGreaterThan(20 * 1024 * 1024);
    const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
    const before = [original, ...references].map(sha);
    const workflowBefore = readFileSync(join(directory, 'workflow.json'));
    const capture = join(project, 'cli-attachments.json');
    const executable = join(project, 'fake-codex');
    writeFileSync(
      executable,
      `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
const images = args.flatMap((arg, index) => arg === '--image' ? [args[index + 1]] : []);
fs.writeFileSync(${JSON.stringify(capture)}, JSON.stringify({args, images: images.map(path => ({path, bytes: fs.statSync(path).size}))}));
process.stdin.resume();
process.stdin.on('end', () => {
  console.log(JSON.stringify({type:'item.completed',item:{id:'result',type:'agent_message',text:${JSON.stringify(JSON.stringify(report()))}}}));
  console.log(JSON.stringify({type:'turn.completed'}));
});
`,
      { mode: 0o700 }
    );
    class FixtureAdapter extends CodexAdapter {
      override async check(): Promise<AgentCheckResult> {
        return { executablePath: executable, version: '0.159.2', availability: 'available', authorization: 'authenticated', message: 'Подставной CLI готов' };
      }
    }
    const settings = new SettingsStore(join(project, 'local'));
    settings.saveAgent({ provider: 'codex' });
    const manager = new AgentManager(settings, { adapter: () => new FixtureAdapter() });
    agents = manager;
    launcher = native;
    const review = create();
    try {
      expect(await review.start(project, directory)).toMatchObject({ status: 'preparing' });
      await vi.waitFor(() => expect(review.view(project, directory).status).not.toBe('preparing'), { timeout: 30000, interval: 50 });
      await vi.waitFor(() => expect(['completed', 'failed']).toContain(review.view(project, directory).status), { timeout: 5000, interval: 20 });
      const view = review.view(project, directory);
      expect(view, JSON.stringify(view)).toMatchObject({ status: 'completed', stale: false, report: report(), durationSeconds: 10.5 });
      expect(view.frames.map(({ id, timeSeconds }) => ({ id, timeSeconds }))).toEqual(
        Array.from({ length: 21 }, (_, index) => ({ id: `F${String(index + 1).padStart(3, '0')}`, timeSeconds: index / 2 }))
      );
      const invocation = JSON.parse(readFileSync(capture, 'utf8')) as { args: string[]; images: Array<{ path: string; bytes: number }> };
      expect(invocation.args[invocation.args.indexOf('--sandbox') + 1]).toBe('read-only');
      expect(invocation.images).toHaveLength(23);
      expect(invocation.images.slice(0, 21).map((image) => image.path)).toEqual(view.frames.map((frame) => frame.path));
      expect(invocation.images.slice(21).map((image) => basename(image.path).split('.')[0])).toEqual(['R001', 'R002']);
      expect(invocation.images.some(({ path }) => /\.jpe?g$/i.test(path))).toBe(true);
      expect(invocation.images.every(({ path, bytes }) => /\.(png|jpe?g)$/i.test(path) && bytes > 0 && bytes <= 5 * 1024 * 1024)).toBe(true);
      expect(invocation.images.reduce((total, image) => total + image.bytes, 0)).toBeLessThanOrEqual(16 * 1024 * 1024);
      expect([original, ...references].map(sha)).toEqual(before);
      expect(readFileSync(join(directory, 'workflow.json'))).toEqual(workflowBefore);
    } finally {
      await manager.shutdownAndWait();
    }
  },
  45000
);
