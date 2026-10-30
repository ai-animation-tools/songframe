/** Архивные попытки референсов проверяются без сети, оплаты и записи рабочих исходников. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaCapabilities } from '@shared/media-providers';
import type { PreparePaidInput } from './media-providers';
import { preparePaidCover, type PaidCoverOptions } from './cover-paid';
import type { CoverGenerationApproval } from '@shared/cover-generation';
import { CoverGeneration, type CoverGenerationOptions, type PreparedCoverCandidateInput } from './cover-generation';
import { imageDimensions } from './keyframe-images';
import { prepareProjectCover } from './cover-provider';
import { SettingsStore } from './settings';
import { registerTestAgentProvider, registerTestMediaProvider, TEST_AGENT_PROVIDER, TEST_PROVIDER, testPaidAdapter } from './testing/media-provider';

let restoreProviders: () => void;
beforeAll(() => {
  const agent = registerTestAgentProvider();
  const paid = registerTestMediaProvider();
  restoreProviders = () => {
    paid();
    agent();
  };
});
afterAll(() => restoreProviders());
let root: string;
let project: string;
let settings: SettingsStore;
let sessions: CoverGeneration[];
function png(path: string, width = 1200, height = 800): void {
  const bytes = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  writeFileSync(path, bytes);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'songframe-reference-generation-'));
  project = join(root, 'project');
  mkdirSync(join(project, 'plan'), { recursive: true });
  mkdirSync(join(project, 'source/heroes'), { recursive: true });
  writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider: TEST_AGENT_PROVIDER, provider_selected: true } } }));
  writeFileSync(join(project, 'source/manifest.json'), 'Сохранённый манифест');
  writeFileSync(join(project, 'source/heroes/oleg.png'), 'Сохранённый референс');
  settings = new SettingsStore(join(root, 'local'));
  sessions = [];
});
afterEach(async () => {
  await Promise.all(sessions.map((session) => session.shutdown()));
  rmSync(root, { recursive: true, force: true });
});
function create(prepareCandidate: CoverGenerationOptions['prepareCandidate'], cropImage = vi.fn()): CoverGeneration {
  const value = new CoverGeneration({ reference: true, settings, readImage: imageDimensions, cropImage, prepareCandidate });
  sessions.push(value);
  return value;
}
function approval(value: CoverGeneration, id: string): CoverGenerationApproval {
  return { approvalToken: value.view(id).approvalToken!, promptConfirmed: true };
}
async function launch(value: CoverGeneration, id: string): Promise<void> {
  const prepared = await value.prepare(id);
  value.generate(id, prepared.requestSha!, approval(value, id));
  await vi.waitFor(() => expect(value.view(id).status).not.toBe('generating'));
}
function sourceSnapshot(): Buffer[] {
  return ['manifest.json', 'heroes/oleg.png'].map((path) => readFileSync(join(project, 'source', path)));
}
function offline(run?: (input: PreparedCoverCandidateInput, signal: AbortSignal) => Promise<{ path: string }>): CoverGenerationOptions['prepareCandidate'] {
  return async (input) => {
    // Подставной провайдер оставляет те же переносимые документы попытки, что и настоящий исполнитель.
    writeFileSync(join(input.workDir, 'request.json'), JSON.stringify({ prompt: input.prompt, purpose: input.purpose }));
    return {
      provider: TEST_AGENT_PROVIDER,
      model: null,
      requestSha: 'same-sha',
      quote: null,
      generate: async (signal) => {
        if (run) return run(input, signal);
        png(join(input.workDir, 'original.png'));
        return { path: 'original.png' };
      }
    };
  };
}

it('сбой записи архива не оставляет генерацию занятой и не запускает исполнителя', async () => {
  const generate = vi.fn(async () => ({ path: 'unused.png' }));
  const value = create(async () => ({ provider: TEST_AGENT_PROVIDER, model: null, quote: null, requestSha: 'sha', generate }));
  const session = value.create(project, 'Референс');
  const request = await value.prepare(session.id);
  const archive = join(project, 'plan/reference-images', session.id, 'session.json');
  mkdirSync(archive);
  expect(() => value.generate(session.id, request.requestSha!, { approvalToken: request.approvalToken!, promptConfirmed: true })).toThrow();
  expect(value.view(session.id).status).toBe('failed');
  expect(generate).not.toHaveBeenCalled();
  rmSync(archive, { recursive: true });
  expect((await value.prepare(session.id)).requestSha).toBe('sha');
});

it('после сбоя архива принимает готовый оплаченный оригинал без повторной генерации', async () => {
  writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider: TEST_PROVIDER, provider_selected: true } } }));
  let receipt = '';
  const generate = vi.fn(async (input: PreparedCoverCandidateInput) => {
    png(join(input.workDir, 'original.png'));
    // Моделируем файловый сбой после получения оригинала, когда запрос уже оплачен.
    rmSync(receipt);
    mkdirSync(receipt);
    return { path: 'original.png' };
  });
  const value = create(async (input) => ({
    provider: TEST_PROVIDER,
    model: null,
    requestSha: 'paid-request',
    quote: { credits: 1, balance: 5, verdict: 'ok' },
    generate: () => generate(input)
  }));
  const { id } = value.create(project, 'Оплаченный референс');
  receipt = join(project, 'plan/reference-images', id, 'session.json');
  await launch(value, id);
  const image = value.view(id).image!;
  const original = readFileSync(image.path);
  try {
    expect(value.view(id)).toMatchObject({
      status: 'ready',
      error: 'Не удалось сохранить сведения о попытке. Оригиналы остаются в архиве проекта; проверьте доступность папки и свободное место.'
    });
    expect(() => value.acceptReference(id)).toThrow();
  } finally {
    // Восстановление диска завершает проверку даже при обнаружении регрессии.
    rmSync(receipt, { recursive: true, force: true });
  }
  // После восстановления диска повторяется только сохранение выбора того же изображения.
  expect(value.acceptReference(id)).toEqual({ id, path: image.path, prompt: 'Оплаченный референс' });
  expect(readFileSync(image.path)).toEqual(original);
  expect(generate).toHaveBeenCalledTimes(1);
});

describe('Генерация архивного референса', () => {
  it('генерирует без изменения source, принимает полный прямоугольный оригинал и сохраняет архив после закрытия', async () => {
    const before = sourceSnapshot();
    const crop = vi.fn();
    const prepare = vi.fn(offline());
    const value = create(prepare, crop);
    const { id } = value.create(project, 'Полный вид героя «&»\nСохранить детали');
    await launch(value, id);
    expect(prepare.mock.calls[0][0].purpose).toBe('reference');
    const image = value.view(id).image!;
    expect(image).toMatchObject({ width: 1200, height: 800 });
    const original = readFileSync(image.path);
    const accepted = value.acceptReference(id);
    expect(accepted).toEqual({ id, path: image.path, prompt: 'Полный вид героя «&»\nСохранить детали' });
    expect(value.acceptReference(id)).toEqual(accepted);
    expect(crop).not.toHaveBeenCalled();
    expect(readFileSync(accepted.path)).toEqual(original);
    expect(sourceSnapshot()).toEqual(before);
    await value.close(id);
    expect(readFileSync(accepted.path)).toEqual(original);
    const archive = join(project, 'plan/reference-images', id);
    const receipt = JSON.parse(readFileSync(join(archive, 'session.json'), 'utf8'));
    expect(receipt).toMatchObject({
      id,
      status: 'accepted',
      prompt: accepted.prompt,
      image: { width: 1200, height: 800, path: relative(archive, accepted.path) }
    });
    expect(readFileSync(join(archive, receipt.image.path))).toEqual(original);
    expect(JSON.parse(readFileSync(join(prepare.mock.calls[0][0].workDir, 'request.json'), 'utf8'))).toEqual({ prompt: accepted.prompt, purpose: 'reference' });
    expect(sourceSnapshot()).toEqual(before);
  });

  it('каждый повтор требует новое одноразовое согласие, сохраняя предыдущие оригиналы и запросы', async () => {
    const workDirs: string[] = [];
    const generate = vi.fn(async (input: PreparedCoverCandidateInput) => {
      workDirs.push(input.workDir);
      png(join(input.workDir, 'original.png'), 1200 + workDirs.length, 800);
      return { path: 'original.png' };
    });
    const value = create(offline(generate));
    const { id } = value.create(project, 'Один точный промпт');
    const first = await value.prepare(id);
    const firstApproval = approval(value, id);
    value.generate(id, first.requestSha!, firstApproval);
    await vi.waitFor(() => expect(value.view(id).status).toBe('ready'));
    const original = value.view(id).image!.path;
    expect(() => value.generate(id, first.requestSha!, firstApproval)).toThrow();
    const second = await value.prepare(id);
    expect(second.requestSha).toBe(first.requestSha);
    expect(second.approvalToken).not.toBe(first.approvalToken);
    expect(() => value.generate(id, second.requestSha!, firstApproval)).toThrow(/Подтвердите/);
    expect(existsSync(original)).toBe(true);
    value.generate(id, second.requestSha!, approval(value, id));
    expect(value.view(id).approvalToken).toBeNull();
    await vi.waitFor(() => expect(value.view(id).status).toBe('ready'));
    expect(generate).toHaveBeenCalledTimes(2);
    await value.close(id);
    for (const workDir of workDirs) expect(readdirSync(workDir).sort()).toEqual(['original.png', 'request.json']);
    expect(existsSync(original)).toBe(true);
  });

  it('после ошибки сохраняет запрос и уже оплаченный оригинал прежней попытки без подмены source', async () => {
    const before = sourceSnapshot();
    let attempt = 0;
    const value = create(
      offline(async (input) => {
        if (++attempt === 2) throw new Error('Провайдер не создал изображение');
        png(join(input.workDir, 'original.png'));
        return { path: 'original.png' };
      })
    );
    const { id } = value.create(project, 'Герой');
    await launch(value, id);
    const original = value.view(id).image!.path;
    await launch(value, id);
    expect(value.view(id)).toMatchObject({ status: 'failed', image: null, requestSha: null });
    expect(() => value.acceptReference(id)).toThrow();
    await value.close(id);
    const archive = join(project, 'plan/reference-images', id, 'image-jobs');
    const jobs = readdirSync(archive);
    expect(jobs).toHaveLength(2);
    expect(jobs.every((job) => existsSync(join(archive, job, 'request.json')))).toBe(true);
    expect(existsSync(original)).toBe(true);
    expect(sourceSnapshot()).toEqual(before);
  });

  it('при отмене ждёт исполнителя и сохраняет поздний оригинал вместе с запросом', async () => {
    const before = sourceSnapshot();
    let started = false;
    let release: (() => void) | undefined;
    let workDir = '';
    const value = create(
      offline(async (input, signal) => {
        workDir = input.workDir;
        started = true;
        await new Promise<void>((resolve) =>
          signal.addEventListener(
            'abort',
            () => {
              release = resolve;
            },
            { once: true }
          )
        );
        png(join(workDir, 'original.png'));
        return { path: 'original.png' };
      })
    );
    const { id } = value.create(project, 'Герой');
    const prepared = await value.prepare(id);
    value.generate(id, prepared.requestSha!, approval(value, id));
    await vi.waitFor(() => expect(started).toBe(true));
    const closing = value.close(id);
    expect(release).toBeDefined();
    release!();
    await closing;
    expect(readdirSync(workDir).sort()).toEqual(['original.png', 'request.json']);
    expect(sourceSnapshot()).toEqual(before);
    expect(() => value.acceptReference(id)).toThrow();
  });

  it('ошибка платной отправки расходует согласие, новый prepare не наследует разрешение неизвестной цены', async () => {
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider: TEST_PROVIDER, provider_selected: true } } }));
    const generate = vi.fn(async () => {
      throw new Error('Ошибка отправки');
    });
    const value = create(async () => ({
      provider: TEST_PROVIDER,
      model: null,
      requestSha: 'sha',
      quote: { credits: null, balance: null, verdict: 'cost_or_balance_unknown' },
      generate
    }));
    const { id } = value.create(project, 'Точный платный запрос');
    await value.prepare(id);
    const first = { ...approval(value, id), allowUnknownCost: true };
    value.generate(id, 'sha', first);
    await vi.waitFor(() => expect(value.view(id).status).toBe('failed'));
    expect(() => value.generate(id, 'sha', first)).toThrow();
    await value.prepare(id);
    expect(() => value.generate(id, 'sha', first)).toThrow(/Подтвердите/);
    expect(() => value.generate(id, 'sha', approval(value, id))).toThrow(/Стоимость или баланс/);
    expect(generate).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), { allowUnknownCost: true });
  });

  it('платный референс сохраняет прямоугольные пропорции проекта и ограничивает отправку одним изображением', async () => {
    writeFileSync(
      join(project, 'plan/project.json'),
      JSON.stringify({
        generation: {
          image: {
            provider: TEST_PROVIDER,
            provider_selected: true,
            options: { aspectRatio: '16:9', imageCount: 8 }
          }
        }
      })
    );
    const capabilities: MediaCapabilities = {
      provider: TEST_PROVIDER,
      kind: 'image',
      available: true,
      checkedAt: '',
      generationVerified: false,
      problems: [],
      models: [{ id: 'model', command: 'text_to_image', arguments: { aspectRatio: { allowed: ['1:1', '16:9'] }, imageCount: {} }, slots: {}, limits: {} }]
    };
    const preparedInputs: PreparePaidInput[] = [];
    const options: PaidCoverOptions = {
      launcher: () => ({
        run: vi.fn(async () => ({ code: 0, command: '', stderr: '', stdout: JSON.stringify({ estimate_credits: 1, balance_credits: 10, verdict: 'ok' }) }))
      }),
      provider: {
        adapter: testPaidAdapter,
        capabilities: vi.fn(async () => capabilities),
        prepare: vi.fn(async (input: PreparePaidInput) => {
          preparedInputs.push(input);
          return { provider: TEST_PROVIDER, kind: 'image' as const, project, requestDir: input.workDir, requestSha: 'sha' };
        }),
        submit: vi.fn(),
        collect: vi.fn()
      }
    };
    const common = { project, workDir: join(root, 'job'), prompt: 'Полный вид окружения', signal: new AbortController().signal };
    await preparePaidCover({ ...common, purpose: 'reference' }, options);
    expect(preparedInputs[0]).toMatchObject({ outputs: 1, parameters: { aspectRatio: '16:9', imageCount: 1 } });
    await preparePaidCover(common, options);
    expect(preparedInputs[1]).toMatchObject({ outputs: 1, parameters: { aspectRatio: '1:1', imageCount: 1 } });
    expect(options.provider.submit).not.toHaveBeenCalled();
  });

  it.each([TEST_AGENT_PROVIDER, TEST_PROVIDER])('передаёт назначение reference выбранному исполнителю %s', async (provider) => {
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider, provider_selected: true } } }));
    const input = { project, workDir: join(root, 'job'), prompt: 'Прямоугольная сцена', purpose: 'reference' as const, signal: new AbortController().signal };
    const run = vi.fn(async () => ({ path: 'original.png' }));
    const paid = vi.fn(async () => ({ provider: TEST_PROVIDER, model: null, requestSha: 'sha', quote: null, generate: run }));
    const prepared = await prepareProjectCover(input, { settings, paid, agent: () => run });
    if (provider === TEST_PROVIDER) expect(paid).toHaveBeenCalledWith(input, TEST_PROVIDER);
    else {
      await prepared.generate(input.signal);
      expect(run).toHaveBeenCalledWith(input);
    }
  });
});
