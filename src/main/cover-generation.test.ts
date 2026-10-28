/** Подставные исполнители проверяют временный цикл обложки без обращения к генераторам. */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import type * as FileSystem from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentEvent, AgentJob, AgentStartInput } from '@shared/agents';
import type { CoverGenerationApproval } from '@shared/cover-generation';
import { CoverGeneration, type CoverGenerationOptions, type PreparedCoverCandidateInput } from './cover-generation';
import { imageDimensions } from './keyframe-images';
import { SettingsStore } from './settings';

vi.mock('node:fs', async (importOriginal) => {
  const original = await importOriginal<typeof FileSystem>();
  return { ...original, mkdtempSync: vi.fn(original.mkdtempSync) };
});

let root: string;
let project: string;
let settings: SettingsStore;
let sessions: CoverGeneration[];
function png(path: string, width = 80, height = 60): void {
  const bytes = Buffer.alloc(32);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(bytes);
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  writeFileSync(path, bytes);
}
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'songframe-cover-test-'));
  project = join(root, 'project');
  mkdirSync(join(project, 'plan'), { recursive: true });
  writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider: 'codex', provider_selected: true } } }));
  settings = new SettingsStore(join(root, 'settings'));
  settings.saveAgent({ provider: 'codex' });
  sessions = [];
});
afterEach(async () => {
  await Promise.all(sessions.map((session) => session.shutdown()));
  rmSync(root, { recursive: true, force: true });
});
function create(options: Partial<CoverGenerationOptions> = {}): CoverGeneration {
  const value = new CoverGeneration({
    settings,
    readImage: imageDimensions,
    cropImage: (_source, target, crop) => png(target, crop.size, crop.size),
    ...options
  });
  sessions.push(value);
  return value;
}
function prepared(run: (input: PreparedCoverCandidateInput) => Promise<{ path: string }>): Pick<CoverGenerationOptions, 'prepareCandidate'> {
  return { prepareCandidate: async (input) => ({ provider: 'codex', model: null, quote: null, requestSha: input.workDir, generate: () => run(input) }) };
}
function approval(value: CoverGeneration, id: string): CoverGenerationApproval {
  return { approvalToken: value.view(id).approvalToken!, promptConfirmed: true };
}
async function launch(value: CoverGeneration, id: string): Promise<void> {
  const request = await value.prepare(id);
  value.generate(id, request.requestSha!, approval(value, id));
  await vi.waitFor(() => expect(value.view(id).status).not.toBe('generating'));
}

describe('Временная генерация обложки', () => {
  it('под Claude готовит и отправляет обложку Codex: агент на провайдера изображений не влияет', async () => {
    settings.saveAgent({ provider: 'claude' });
    const generate = vi.fn(async () => ({ path: 'cover.png' }));
    const prepareCandidate = vi.fn(async () => ({ provider: 'codex' as const, model: null, requestSha: 'request', quote: null, generate }));
    const value = create({ prepareCandidate });
    const { id } = value.create(project, 'Обложка');
    await value.prepare(id);
    value.generate(id, 'request', approval(value, id));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
  });

  it.each(['codex', 'kling'])('сохранённый %s без явного выбора не создаёт временную папку', (provider) => {
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider } } }));
    const prepareCandidate = vi.fn();
    const value = create({ prepareCandidate });
    const temporaryDirectories = vi.mocked(mkdtempSync).mock.calls.length;
    expect(() => value.create(project, 'Обложка')).toThrow('выберите провайдера изображений');
    expect(vi.mocked(mkdtempSync).mock.calls).toHaveLength(temporaryDirectories);
    expect(prepareCandidate).not.toHaveBeenCalled();
  });

  it('снятие явного выбора провайдера запрещает подготовку и ранее согласованную отправку', async () => {
    const generate = vi.fn(async () => ({ path: 'cover.png' }));
    const prepareCandidate = vi.fn(async () => ({ provider: 'codex' as const, model: null, requestSha: 'request', quote: null, generate }));
    const value = create({ prepareCandidate });
    const { id } = value.create(project, 'Обложка');
    await value.prepare(id);
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider: 'codex', provider_selected: false } } }));
    await expect(value.prepare(id)).rejects.toThrow('выберите провайдера изображений');
    expect(() => value.generate(id, 'request', approval(value, id))).toThrow('выберите провайдера изображений');
    expect(prepareCandidate).toHaveBeenCalledTimes(1);
    expect(generate).not.toHaveBeenCalled();
  });

  it.each(['codex', 'kling'] as const)('без выбранного агента готовит и отправляет обложку %s', async (provider) => {
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider, provider_selected: true } } }));
    settings.saveAgent(null);
    const generate = vi.fn(async () => ({ path: 'cover.png' }));
    const prepareCandidate = vi.fn(async () => ({
      provider,
      model: null,
      requestSha: 'request',
      quote: { credits: 1, balance: 2, verdict: 'ok' as const },
      generate
    }));
    const value = create({ prepareCandidate });
    const { id } = value.create(project, 'Обложка');
    const request = await value.prepare(id);
    value.generate(id, request.requestSha!, approval(value, id));
    await vi.waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await value.close(id);
  });

  it('повторно проверяет выбор провайдера изображений перед отложенной отправкой', async () => {
    const generate = vi.fn(async () => ({ path: 'cover.png' }));
    const value = create({ prepareCandidate: async () => ({ provider: 'codex', model: null, requestSha: 'request', quote: null, generate }) });
    const { id } = value.create(project, 'Обложка');
    await value.prepare(id);
    value.generate(id, 'request', approval(value, id));
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider: 'codex', provider_selected: false } } }));
    await vi.waitFor(() => expect(value.view(id)).toMatchObject({ status: 'failed', image: null }));
    expect(value.view(id).error).toContain('выберите провайдера изображений');
    expect(generate).not.toHaveBeenCalled();
  });

  it('принимает созданную обложку и очищает сессию после отключения агента', async () => {
    const value = create(
      prepared(async ({ workDir }) => {
        png(join(workDir, 'cover.png'));
        return { path: 'cover.png' };
      })
    );
    const { id } = value.create(project, 'Обложка');
    await launch(value, id);
    settings.saveAgent(null);
    const accepted = value.accept(id, { x: 0, y: 0, size: 60 });
    expect(existsSync(accepted.path)).toBe(true);
    await value.close(id);
    expect(existsSync(accepted.path)).toBe(false);
  });

  it('сохраняет фиксированный Codex промпт и пользовательский контекст при повторе; всё состояние находится в tmp', async () => {
    writeFileSync(
      join(project, 'plan/project.json'),
      JSON.stringify({ generation: { image: { provider: 'codex', model: ' cover-model ', provider_selected: true } } })
    );
    settings.saveAgent({ provider: 'codex', model: 'text-model' });
    const initialSettings = readFileSync(join(settings.localDir, 'settings.json'), 'utf8');
    const inputs: AgentStartInput[] = [];
    const models: Array<string | undefined> = [];
    const workDirs: string[] = [];
    const value = create({
      createManager: (temporarySettings) => {
        expect(temporarySettings.localDir).not.toBe(settings.localDir);
        expect(temporarySettings.getImageAgent()).toEqual(settings.getImageAgent());
        let job: AgentJob;
        return {
          startImages: (input, workDir, model) => {
            inputs.push(input);
            models.push(model);
            workDirs.push(workDir);
            png(join(workDir, 'cover.png'));
            job = { id: 'job', status: 'completed', exitCode: 0, result: '{"path":"cover.png"}' } as AgentJob;
            return job;
          },
          get: () => job,
          onEvent: (_listener: (event: AgentEvent) => void) => () => undefined,
          shutdownAndWait: async () => undefined
        };
      }
    });
    const { id } = value.create(project, '  Ёж у костра  ');
    await launch(value, id);
    const first = value.view(id).image!.path;
    const next = await value.prepare(id);
    expect(existsSync(first)).toBe(true);
    value.generate(id, next.requestSha!, approval(value, id));
    expect(existsSync(first)).toBe(false);
    await vi.waitFor(() => expect(value.view(id).status).toBe('ready'));
    expect(inputs).toHaveLength(2);
    // Временный проект обложки не содержит настроек: модель передаётся явно, без модели текстового агента.
    expect(models).toEqual(['cover-model', 'cover-model']);
    expect(inputs[0].prompt).toBe(inputs[1].prompt);
    expect(inputs[0].prompt).toContain('image_gen');
    expect(inputs[0].context).toBe(JSON.stringify({ userPrompt: '  Ёж у костра  ' }));
    expect(inputs[0].project).not.toBe(project);
    expect(readdirSync(project)).toEqual(['plan']);
    expect(readdirSync(join(project, 'plan'))).toEqual(['project.json']);
    expect(readFileSync(join(settings.localDir, 'settings.json'), 'utf8')).toBe(initialSettings);
    await value.close(id);
    expect(workDirs.every((path) => !existsSync(path))).toBe(true);
  });

  it('проверяет квадрат, сохраняет только принятый PNG и удаляет его после закрытия формы', async () => {
    const value = create(
      prepared(async ({ workDir }) => {
        png(join(workDir, 'cover.png'));
        writeFileSync(join(workDir, 'extra.txt'), 'Черновик');
        return { path: 'cover.png' };
      })
    );
    const { id } = value.create(project, 'Обложка');
    await launch(value, id);
    const original = value.view(id).image!.path;
    for (const crop of [
      { x: -1, y: 0, size: 10 },
      { x: 0, y: 0, size: 61 },
      { x: 0.5, y: 0, size: 10 },
      { x: 80, y: 0, size: 1 }
    ])
      expect(() => value.accept(id, crop)).toThrow(/квадратную область/);
    const next = await value.prepare(id);
    expect(next.image?.path).toBe(original);
    const accepted = value.accept(id, { x: 20, y: 0, size: 60 });
    expect(value.view(id)).toMatchObject({ status: 'accepted', image: { width: 60, height: 60 } });
    expect(existsSync(original)).toBe(false);
    expect(readdirSync(dirname(accepted.path))).toEqual(['accepted.png']);
    expect(() => value.generate(id, next.requestSha!, approval(value, id))).toThrow(/уже выбрана/);
    await value.close(id);
    expect(existsSync(accepted.path)).toBe(false);
    expect(() => value.view(id)).toThrow(/закрыта/);
  });

  it.each(['../outside.png', 'link.png', 'wrong.jpg', 'broken.png'])('отклоняет неверный результат %s и очищает кандидаты', async (path) => {
    let workDir = '';
    const value = create(
      prepared(async (input) => {
        workDir = input.workDir;
        png(join(workDir, 'valid.png'));
        png(join(dirname(workDir), 'outside.png'));
        symlinkSync(join(workDir, 'valid.png'), join(workDir, 'link.png'));
        png(join(workDir, 'wrong.jpg'));
        writeFileSync(join(workDir, 'broken.png'), 'Ошибка');
        return { path };
      })
    );
    const { id } = value.create(project, 'Обложка');
    await launch(value, id);
    expect(value.view(id)).toMatchObject({ status: 'failed', image: null, requestSha: null });
    expect(value.view(id).error).toBeTruthy();
    expect(existsSync(workDir)).toBe(false);
  });

  it('отменяет исполнителя и ждёт его завершения перед удалением временной папки', async () => {
    let workDir = '';
    let release: (() => void) | undefined;
    const value = create({
      prepareCandidate: async (input) => ({
        provider: 'codex',
        model: null,
        quote: null,
        requestSha: 'request',
        generate: async (signal) => {
          workDir = input.workDir;
          await new Promise<void>((finish) =>
            signal.addEventListener(
              'abort',
              () => {
                release = finish;
              },
              { once: true }
            )
          );
          png(join(workDir, 'late.png'));
          return { path: 'late.png' };
        }
      })
    });
    const { id } = value.create(project, 'Обложка');
    const request = await value.prepare(id);
    value.generate(id, request.requestSha!, approval(value, id));
    await vi.waitFor(() => expect(workDir).not.toBe(''));
    expect(() => value.generate(id, request.requestSha!, approval(value, id))).toThrow(/Дождитесь/);
    expect(() => value.accept(id, { x: 0, y: 0, size: 1 })).toThrow(/дождитесь/);
    const closed = value.close(id);
    expect(existsSync(workDir)).toBe(true);
    expect(release).toBeDefined();
    release!();
    await closed;
    expect(existsSync(workDir)).toBe(false);
  });

  it('проверяет SHA и стоимость Kling; не повторяет неудачную отправку без нового prepare', async () => {
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider: 'kling', provider_selected: true } } }));
    const generate = vi.fn(async () => {
      throw new Error('Не удалось создать обложку.');
    });
    const value = create({
      prepareCandidate: async () => ({ provider: 'kling', model: 'kling', requestSha: 'sha', quote: { credits: 2, balance: 3, verdict: 'ok' }, generate })
    });
    const { id } = value.create(project, 'Обложка');
    await value.prepare(id);
    expect(() => value.generate(id, 'old-sha', approval(value, id))).toThrow(/подготовьте/);
    value.generate(id, 'sha', approval(value, id));
    await vi.waitFor(() => expect(value.view(id).status).toBe('failed'));
    expect(generate).toHaveBeenCalledTimes(1);
    expect(() => value.generate(id, 'sha', approval(value, id))).toThrow(/подготовьте/);
    const unknown = create({ prepareCandidate: async () => ({ provider: 'kling', model: null, requestSha: 'unknown', quote: null, generate }) });
    const session = unknown.create(project, 'Обложка');
    await unknown.prepare(session.id);
    expect(() => unknown.generate(session.id, 'unknown', approval(unknown, session.id))).toThrow(/Стоимость или баланс/);
    expect(generate).toHaveBeenCalledTimes(1);
  });

  it('требует подтверждение промпта и свежий токен даже при совпадающем SHA; сохраняет старую обложку до согласия', async () => {
    const generate = vi.fn(async (_signal: AbortSignal, _consent?: { allowUnknownCost?: boolean }) => ({ path: 'cover.png' }));
    const value = create({
      prepareCandidate: async ({ workDir }) => ({
        provider: 'codex',
        model: null,
        requestSha: 'same-sha',
        quote: null,
        generate: async (signal, consent) => {
          await generate(signal, consent);
          png(join(workDir, 'cover.png'));
          return { path: 'cover.png' };
        }
      })
    });
    const { id } = value.create(project, 'Точный промпт');
    expect(value.view(id).approvalToken).toBeNull();
    await launch(value, id);
    const original = value.view(id).image!.path;
    const first = await value.prepare(id);
    const second = await value.prepare(id);
    expect(first.requestSha).toBe(second.requestSha);
    expect(first.approvalToken).not.toBe(second.approvalToken);
    expect(() => value.generate(id, 'same-sha', { approvalToken: first.approvalToken!, promptConfirmed: true })).toThrow('Подтвердите показанный промпт');
    expect(() =>
      value.generate(id, 'same-sha', { approvalToken: second.approvalToken!, promptConfirmed: false } as unknown as CoverGenerationApproval)
    ).toThrow('Подтвердите показанный промпт');
    expect(() => value.generate(id, 'same-sha', undefined as unknown as CoverGenerationApproval)).toThrow('Подтвердите показанный промпт');
    expect(existsSync(original)).toBe(true);
    expect(value.view(id).approvalToken).toBe(second.approvalToken);
    expect(generate).toHaveBeenCalledTimes(1);
    value.generate(id, 'same-sha', approval(value, id));
    expect(value.view(id).approvalToken).toBeNull();
    await vi.waitFor(() => expect(value.view(id).status).toBe('ready'));
    expect(generate).toHaveBeenCalledTimes(2);
  });

  it.each([
    [{ credits: null, balance: null, verdict: 'cost_or_balance_unknown' as const }, false, false],
    [{ credits: null, balance: null, verdict: 'cost_or_balance_unknown' as const }, true, true],
    [{ credits: 10, balance: 1, verdict: 'insufficient_balance' as const }, true, false],
    [{ credits: 10, balance: null, verdict: 'cost_or_balance_unknown' as const }, true, false]
  ])('отправляет неизвестную цену только с отдельным согласием: %j / %s', async (quote, allowUnknownCost, allowed) => {
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider: 'kling', provider_selected: true } } }));
    const generate = vi.fn(async () => {
      throw new Error('Тестовая остановка после разрешения отправки.');
    });
    const value = create({ prepareCandidate: async () => ({ provider: 'kling', model: null, requestSha: 'sha', quote, generate }) });
    const { id } = value.create(project, 'Обложка');
    await value.prepare(id);
    const consent = { ...approval(value, id), allowUnknownCost };
    if (allowed) {
      value.generate(id, 'sha', consent);
      await vi.waitFor(() => expect(value.view(id).status).toBe('failed'));
      expect(generate).toHaveBeenCalledExactlyOnceWith(expect.any(AbortSignal), { allowUnknownCost: true });
      expect(() => value.generate(id, 'sha', consent)).toThrow('подготовьте');
    } else {
      expect(() => value.generate(id, 'sha', consent)).toThrow('Стоимость или баланс');
      expect(value.view(id).approvalToken).toBe(consent.approvalToken);
      expect(generate).not.toHaveBeenCalled();
    }
  });

  it('не запускает генерацию после немедленного закрытия и дожидается подготовки перед очисткой', async () => {
    const generate = vi.fn(async () => ({ path: 'cover.png' }));
    const immediate = create({
      prepareCandidate: async () => ({ provider: 'codex', model: null, requestSha: 'request', quote: null, generate })
    });
    const first = immediate.create(project, 'Обложка');
    await immediate.prepare(first.id);
    immediate.generate(first.id, 'request', approval(immediate, first.id));
    await immediate.close(first.id);
    expect(generate).not.toHaveBeenCalled();

    let workDir = '';
    let finish: (() => void) | undefined;
    const waiting = create({
      prepareCandidate: async (input) => {
        workDir = input.workDir;
        await new Promise<void>((resolve) =>
          input.signal.addEventListener(
            'abort',
            () => {
              finish = resolve;
            },
            { once: true }
          )
        );
        writeFileSync(join(workDir, 'late.txt'), 'Подготовка завершена');
        return { provider: 'codex', model: null, requestSha: 'request', quote: null, generate };
      }
    });
    const second = waiting.create(project, 'Обложка');
    const preparation = waiting.prepare(second.id).catch((error: Error) => error.message);
    const closing = waiting.close(second.id);
    expect(existsSync(workDir)).toBe(true);
    finish!();
    await closing;
    expect(await preparation).toMatch(/закрыта/);
    expect(existsSync(workDir)).toBe(false);
  });

  it('проверяет проект и описание до создания сессии', () => {
    const value = create();
    expect(() => value.create(project, '  ')).toThrow(/описание/);
    expect(() => value.create(project, 'a'.repeat(33 * 1024))).toThrow(/32 КБ/);
    expect(() => value.create(root, 'Обложка')).toThrow(/plan\/project.json/);
  });

  it('сразу показывает провайдера Kling и сохраняет его при ошибке подготовки', async () => {
    writeFileSync(
      join(project, 'plan/project.json'),
      JSON.stringify({ generation: { image: { provider: 'kling', provider_selected: true, model: 'kling-v3' } } })
    );
    const value = create({
      prepareCandidate: async () => {
        throw new Error('Сервис Kling недоступен.');
      }
    });
    const session = value.create(project, 'Обложка');
    expect(session).toMatchObject({ provider: 'kling', model: 'kling-v3', status: 'idle' });
    expect(await value.prepare(session.id)).toMatchObject({ provider: 'kling', model: 'kling-v3', status: 'failed', requestSha: null });
  });

  it.each([{}, { generation: { image: { provider: 'other' } } }])('отклоняет проект без поддерживаемого провайдера', (manifest) => {
    writeFileSync(join(project, 'plan/project.json'), JSON.stringify(manifest));
    expect(() => create().create(project, 'Обложка')).toThrow(/провайдера изображений/);
  });
});
