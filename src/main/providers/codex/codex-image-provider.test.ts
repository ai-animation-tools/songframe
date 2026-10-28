/** Адаптер Codex: подготовка, одноразовое подтверждение и сбор опор без запуска настоящего агента. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentJob } from '@shared/agents';
import { KeyframeImages } from '../../keyframe-images';
import { CodexImageProvider, type CodexImageProviderOptions } from './codex-image-provider';

const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
let work: string;
let project: string;
let options: CodexImageProviderOptions;
let input: { workDir: string };

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-codex-images-'));
  project = join(work, 'project');
  mkdirSync(join(project, 'source'), { recursive: true });
  mkdirSync(join(project, 'plan'), { recursive: true });
  writeFileSync(join(project, 'source/reference.png'), png);
  imageSettings({ provider: 'codex', provider_selected: true });
  input = { workDir: join(work, 'attempt') };
  options = {
    agent: (model) => ({ provider: 'codex', ...(model?.trim() ? { model: model.trim() } : {}) }),
    checkCodex: async () => ({ availability: 'available', authorization: 'authenticated', message: 'Готово' }),
    images: new KeyframeImages({ localDir: join(work, 'state'), agents: { startImages: vi.fn() } })
  };
});
afterEach(() => rmSync(work, { recursive: true, force: true }));
function imageSettings(image: Record<string, unknown>): void {
  writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ name: 'Клип', generation: { image } }));
}

describe('опоры Codex', () => {
  it('Codex после перезапуска восстанавливает SHA из job.json', () => {
    const productionInput = {
      project,
      shot: 'M01',
      packageDir: input.workDir,
      frames: [{ id: 'K01', role: 'first' as const, timeSeconds: 0, prompt: 'Кадр', referencePaths: [] }]
    };
    const job = {
      id: 'persisted-agent',
      project,
      provider: 'codex',
      status: 'completed',
      exitCode: 0,
      result: JSON.stringify({ schemaVersion: 1, stage: 'frames', images: [{ id: 'K01', path: 'K01.png' }] })
    } as AgentJob;
    const localDir = join(work, 'restart-state');
    const createImages = (): KeyframeImages =>
      new KeyframeImages({
        localDir,
        agents: {
          startImages: (_input, directory) => {
            writeFileSync(join(directory, 'K01.png'), png);
            return job;
          }
        }
      });
    options.images = createImages();
    const initial = new CodexImageProvider(options);
    const prepared = initial.prepare(productionInput);
    initial.submit(prepared, { requestSha: prepared.requestSha });
    options.images = createImages();
    expect(options.images.getRequestSha(job)).toBe(prepared.requestSha);
    expect(new CodexImageProvider(options).collectJob(job)).toMatchObject([{ index: 1, frameId: 'K01', kind: 'image', width: 1, height: 1 }]);
    // Задание без записи согласованного запроса не собирается.
    expect(() => new CodexImageProvider(options).collectJob({ ...job, id: 'unknown-agent' })).toThrow(/Рабочая папка опор недоступна/);
  });

  it('Codex проверяет CLI, но не сообщает о подтверждённом image tool и не запускает его при discovery/prepare', async () => {
    const start = vi.spyOn(options.images, 'start');
    const provider = new CodexImageProvider(options);
    const capabilities = await provider.capabilities(project);
    expect(capabilities).toMatchObject({ available: true, models: [], generationVerified: false });
    expect(capabilities.problems).toEqual([]);
    const prepared = provider.prepare({
      project,
      shot: 'M01',
      packageDir: input.workDir,
      frames: [{ id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Первый кадр', referencePaths: ['source/reference.png'] }]
    });
    expect(prepared.references[0].sha256).toBe(hash(png));
    expect(start).not.toHaveBeenCalled();
    expect(() => provider.submit(prepared, { requestSha: 'wrong' })).toThrow(/изменились/);
    writeFileSync(join(project, 'source/reference.png'), Buffer.concat([png, Buffer.from('изменено')]));
    expect(() => provider.submit(prepared, { requestSha: prepared.requestSha })).toThrow(/изменились/);
    expect(start).not.toHaveBeenCalled();
  });

  it('Codex discovery загружает реальный каталог моделей агента, не подтверждая image tool', async () => {
    const models = [{ id: 'account-model', command: 'codex_exec', arguments: {}, slots: {}, limits: {} }];
    options.listCodexModels = vi.fn(async () => models);
    const start = vi.spyOn(options.images, 'start');
    const result = await new CodexImageProvider(options).capabilities(project);
    expect(result).toMatchObject({ available: true, models, generationVerified: false, problems: [] });
    expect(options.listCodexModels).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('сбой каталога Codex не превращается в отсутствие CLI; недоступный CLI каталог не запрашивает', async () => {
    options.listCodexModels = vi.fn(async () => {
      throw new Error('fixture network failure');
    });
    const provider = new CodexImageProvider(options);
    expect(await provider.capabilities(project)).toMatchObject({
      available: true,
      models: [],
      generationVerified: false,
      problems: ['Каталог моделей агента Codex сейчас недоступен. Повторите проверку возможностей.']
    });
    options.checkCodex = async () => ({ availability: 'not_found', authorization: 'unknown', message: 'Codex не найден.' });
    expect(await provider.capabilities(project)).toMatchObject({ available: false, models: [], generationVerified: false, problems: ['Codex не найден.'] });
    expect(options.listCodexModels).toHaveBeenCalledTimes(1);
  });

  it('Codex расходует prepared и permit один раз, сохраняя возможность нового явного запуска тех же входов', () => {
    const provider = new CodexImageProvider(options);
    const source = {
      project,
      shot: 'M01',
      packageDir: input.workDir,
      frames: [{ id: 'K01', role: 'first' as const, timeSeconds: 0, prompt: 'Кадр', referencePaths: [] }]
    };
    const prepared = provider.prepare(source);
    const permit = { requestSha: prepared.requestSha };
    const start = vi.spyOn(options.images, 'start').mockReturnValue({ id: 'agent-job' } as AgentJob);
    provider.submit(prepared, permit);
    expect(() => provider.submit(prepared, permit)).toThrow(/уже использованы/);
    expect(() => provider.submit(prepared, { requestSha: prepared.requestSha })).toThrow(/уже использованы/);
    const next = provider.prepare(source);
    expect(next.requestSha).toBe(prepared.requestSha);
    expect(() => provider.submit(next, permit)).toThrow(/уже использованы/);
    expect(start).toHaveBeenCalledTimes(1);
    provider.submit(next, { requestSha: next.requestSha });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('Codex после ошибки start требует новую подготовку и новый permit', () => {
    const provider = new CodexImageProvider(options);
    const source = {
      project,
      shot: 'M01',
      packageDir: input.workDir,
      frames: [{ id: 'K01', role: 'first' as const, timeSeconds: 0, prompt: 'Кадр', referencePaths: [] }]
    };
    const prepared = provider.prepare(source);
    const permit = { requestSha: prepared.requestSha };
    const start = vi
      .spyOn(options.images, 'start')
      .mockImplementationOnce(() => {
        throw new Error('Не удалось запустить CLI');
      })
      .mockReturnValue({ id: 'retry-job' } as AgentJob);
    expect(() => provider.submit(prepared, permit)).toThrow(/Не удалось запустить CLI/);
    expect(() => provider.submit(prepared, { requestSha: prepared.requestSha })).toThrow(/уже использованы/);
    const retry = provider.prepare(source);
    expect(() => provider.submit(retry, permit)).toThrow(/уже использованы/);
    expect(start).toHaveBeenCalledTimes(1);
    provider.submit(retry, { requestSha: retry.requestSha });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('Codex связывает задание с requestSHA и собирает результат через существующий collector', () => {
    const provider = new CodexImageProvider(options);
    const prepared = provider.prepare({
      project,
      shot: 'M01',
      packageDir: input.workDir,
      frames: [{ id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Кадр', referencePaths: [] }]
    });
    const job = { id: 'agent-job' } as AgentJob;
    const start = vi.spyOn(options.images, 'start').mockReturnValue(job);
    const ref = provider.submit(prepared, { requestSha: prepared.requestSha });
    expect(start).toHaveBeenCalledWith(prepared.input, { provider: 'codex', requestSha: prepared.requestSha, agent: { provider: 'codex' } });
    const file = join(work, 'image.png');
    writeFileSync(file, png);
    const collect = vi.spyOn(options.images, 'collect').mockReturnValue([{ id: 'K01', path: file }]);
    expect(provider.collect(ref, job)).toEqual([{ path: file, frameId: 'K01', index: 1, kind: 'image', sha256: hash(png), width: 1, height: 1 }]);
    expect(collect).toHaveBeenCalledWith(job, prepared.requestSha);
  });

  it.each([
    [
      { provider: 'codex', model: ' codex-image-model ', provider_selected: true },
      { provider: 'codex', model: 'codex-image-model' }
    ],
    [{ provider: 'codex', model: '  ', provider_selected: true }, { provider: 'codex' }],
    [{ provider: 'other', model: 'other-image-model', provider_selected: true }, { provider: 'codex' }]
  ])('модель Codex берётся только из настроек изображений Codex: %j', (image, agent) => {
    imageSettings(image);
    const provider = new CodexImageProvider(options);
    const prepared = provider.prepare({
      project,
      shot: 'M01',
      packageDir: input.workDir,
      frames: [{ id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Кадр', referencePaths: [] }]
    });
    const start = vi.spyOn(options.images, 'start').mockReturnValue({ id: 'agent-job' } as AgentJob);
    provider.submit(prepared, { requestSha: prepared.requestSha });
    expect(start).toHaveBeenCalledWith(prepared.input, { provider: 'codex', requestSha: prepared.requestSha, agent });
  });
});
