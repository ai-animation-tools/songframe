/** Две опоры проходят штатные quote/Jobs/выбор; все CLI и байты загрузки локальные, сеть запрещена. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobInfo } from '@shared/types';
import { Jobs } from './jobs';
import { PaidMediaProvider, type MediaProviderOptions } from './media-providers';
import { Production, readPackage } from './production';
import { paidAdapter } from './providers';
import { PythonLauncher } from './python-launcher';
import { registerTestMediaProvider, TEST_PROVIDER } from './testing/media-provider';

const root = resolve(__dirname, '../..');
let directory: string;
let project: string;
const digest = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
const json = (path: string): Record<string, unknown> => JSON.parse(readFileSync(path, 'utf8'));
const write = (path: string, value: unknown): void => writeFileSync(path, JSON.stringify(value, null, 2));
function treeHashes(base: string): Record<string, string> {
  const result: Record<string, string> = {};
  const visit = (path: string): void => {
    for (const entry of readdirSync(path, { withFileTypes: true })) {
      const child = join(path, entry.name);
      if (entry.isDirectory()) visit(child);
      else if (entry.isFile()) result[relative(base, child)] = digest(child);
    }
  };
  visit(base);
  return result;
}

/** Журнал тестового сервиса провайдера `test`: отправки и опросы считаются по нему. */
function serviceCalls(action: string): Record<string, unknown>[] {
  const path = join(directory, 'service', 'calls.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line) as Record<string, unknown>)
        .filter((call) => call.action === action)
    : [];
}
const submissions = (): Record<string, unknown>[] => serviceCalls('submit');
const serviceConfig = (): string => join(directory, 'service', 'service.json');
/** Платный провайдер — тестовый `test`; «результатом» генерации служит референс лодки, сеть не используется. */
function fakeService(submit: unknown = { generation_id: 'image-job-1', credits_consumed: 2 }): void {
  const model = {
    arguments: { prompt: { required: true }, resolution: { allowed: ['1k'] }, image_count: { allowed: ['1'] } },
    slots: { image_1: { required: true } },
    limits: {}
  };
  mkdirSync(join(directory, 'service'), { recursive: true });
  write(serviceConfig(), {
    reports: { image: ['text_to_image', 'image_to_image'].map((command) => ({ command, models: { 'integration-image': model } })) },
    submit,
    results: { image: join(project, 'source/vehicles/boat.png') }
  });
  vi.stubEnv('SONGFRAME_TEST_MEDIA_SERVICE', serviceConfig());
  const pricing = join(directory, 'pricing.json');
  write(pricing, { schema_version: 1, currency: 'credits', models: { 'integration-image': { per_image: 2 } }, observed: [] });
  vi.stubEnv('SONGFRAME_PRICING_FILE', pricing);
}
async function done(jobs: Jobs, jobId: string): Promise<JobInfo> {
  await vi.waitFor(() => expect(jobs.get(jobId)?.status).not.toBe('running'), { timeout: 20_000, interval: 25 });
  return jobs.get(jobId)!;
}

let restoreProvider: () => void;
beforeEach(() => {
  restoreProvider = registerTestMediaProvider();
  directory = mkdtempSync(join(tmpdir(), 'songframe-image-integration-'));
  project = join(directory, 'Пробный клип');
  cpSync(join(root, 'tools/testdata/sample-project'), project, { recursive: true });
});
afterEach(() => {
  restoreProvider();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('сквозная image-ветка с тестовым провайдером', () => {
  it('проводит две опоры через quote/send/collect/select, принимает вручную загруженный результат неизвестной отправки и утверждает отдельно', async () => {
    const sourcesBefore = treeHashes(join(project, 'source'));
    const assetsBefore = treeHashes(join(project, 'assets'));
    fakeService();
    const localDir = join(directory, 'state');
    const launcher = new PythonLauncher({ toolsRoot: root, localDir });
    const jobs = new Jobs(root, localDir, launcher);
    const production = new Production(root, jobs);
    const options: MediaProviderOptions = { launcher: () => launcher };
    const adapter = paidAdapter(TEST_PROVIDER)!;
    const image = new PaidMediaProvider(adapter, 'image', options);
    production.setMediaProviders({ [TEST_PROVIDER]: { image, video: new PaidMediaProvider(adapter, 'video', options) } });
    const capabilities = await image.capabilities(project);
    expect(capabilities.available).toBe(true);
    expect(submissions()).toHaveLength(0);
    const pkg = join(project, 'plan/batches/M03-images-integration');
    const tool = async (args: string[]): Promise<void> => {
      const result = await launcher.run(project, 'shot_workflow', args);
      expect(result.code, result.stderr || result.stdout).toBe(0);
    };
    await tool(['init', 'M03', '--dir', pkg]);
    await tool(['plan-keyframes', '--dir', pkg, '--request-seconds', '5']);
    mkdirSync(join(pkg, 'video-request'));
    write(join(pkg, 'video-request/request.json'), { kind: 'video', provider: TEST_PROVIDER, model: 'saved-video', inputs: [], parameters: {} });
    write(join(pkg, 'video-request/attempt.json'), { status: 'downloaded', generation_id: 'existing-video', downloads: [{ path: 'original.mp4' }] });
    writeFileSync(join(pkg, 'video-request/original.mp4'), 'Ранее оплаченный видеооригинал');
    const videoBefore = treeHashes(join(pkg, 'video-request'));
    await tool(['set-stage', '--dir', pkg, 'description_review', '--request-dir', 'video-request']);
    await tool(['ask', '--dir', pkg, '--stage', 'description_review']);
    await production.decide(project, pkg, 'approve', '', readPackage(project, pkg)!.decisionToken);
    const originals = new Map<string, string>();
    for (const [offset, frameId] of ['K01', 'K02'].entries()) {
      const requestDir = join(pkg, `image-${frameId}`);
      const prepared = await image.prepare(
        {
          project,
          shot: 'M03',
          kind: 'image',
          command: 'image_to_image',
          model: 'integration-image',
          prompt: `Опора ${frameId}: сохранить внешность лодки.`,
          parameters: { resolution: '1k', image_count: 1 },
          inputs: [{ flag: 'input', slot: 'image_1', path: 'source/vehicles/boat.png', role: 'reference' }],
          outputs: 1,
          workDir: requestDir,
          frameId
        },
        capabilities
      );
      await tool(['set-image-request', '--dir', pkg, '--frame', frameId, '--request-dir', relative(pkg, requestDir)]);
      let view = readPackage(project, pkg)!;
      expect(view).toMatchObject({ stage: 'image_request_choice', request: { kind: 'image', frameId, sha256: prepared.requestSha } });
      expect(view.pendingDecision?.options).toContain('send');
      if (frameId === 'K01') {
        const frozenBefore = treeHashes(requestDir);
        await production.decide(project, pkg, 'revise', 'Проверить образ перед отправкой', view.decisionToken);
        expect(readPackage(project, pkg)!.stage).toBe('keyframes_review');
        expect(submissions()).toHaveLength(0);
        await tool(['set-image-request', '--dir', pkg, '--frame', frameId, '--request-dir', relative(pkg, requestDir)]);
        view = readPackage(project, pkg)!;
        await production.decide(project, pkg, 'park', '', view.decisionToken);
        view = readPackage(project, pkg)!;
        expect(view.pendingDecision).toBeNull();
        expect(treeHashes(requestDir)).toEqual(frozenBefore);
        // Новое нажатие подтверждения после park обязано записать send до единственной отправки.
      }
      // Окно может держать более раннюю оценку тех же материалов: она действует, а отправка сжигает все оценки пакета.
      const earlierQuote = await production.quote(project, pkg, prepared.requestSha, view.decisionToken);
      const quote = await production.quote(project, pkg, prepared.requestSha, view.decisionToken);
      expect(quote).toMatchObject({ verdict: 'ok', credits: 2, balance: 1000 });
      expect(submissions()).toHaveLength(offset);
      // Ответ без ID задания: исход второй отправки неизвестен.
      if (frameId === 'K02') fakeService('unknown');
      const submitted = await production.submit(project, pkg, prepared.requestSha, view.decisionToken, earlierQuote.token);
      const completed = await done(jobs, submitted.id);
      expect(submissions()).toHaveLength(offset + 1);
      if (frameId === 'K02') {
        expect(completed.status, completed.log).toBe('failed');
        expect(readPackage(project, pkg)!.request).toMatchObject({ attemptStatus: 'submission_unknown', generationId: null });
        await expect(production.submit(project, pkg, prepared.requestSha, view.decisionToken, quote.token)).rejects.toThrow();
        expect(() => production.resume(project, pkg)).toThrow(/историю генераций/);
        // ID задания не узнать: пользователь находит изображение в истории генераций сервиса и загружает его вручную.
        const attached = await done(jobs, production.attachResult(project, pkg, [join(project, 'source/vehicles/boat.png')]).id);
        expect(attached.status, attached.log).toBe('done');
        expect(readPackage(project, pkg)!.request).toMatchObject({ manualResult: true, generationId: null });
        expect(submissions()).toHaveLength(2);
      } else expect(completed.status, completed.log).toBe('done');
      let downloaded = readPackage(project, pkg)!;
      expect(downloaded.stage).toBe('image_downloaded');
      expect(downloaded.request!.downloads).toHaveLength(1);
      const original = downloaded.request!.downloads[0];
      originals.set(original, digest(original));
      expect(image.collect(prepared)).toMatchObject([{ index: 1, kind: 'image', frameId }]);
      expect(digest(original)).toBe(digest(join(project, 'source/vehicles/boat.png')));
      const staleResult = downloaded.resultToken!;
      const attemptPath = join(requestDir, 'attempt.json');
      write(attemptPath, { ...json(attemptPath), fixture_note: 'Изменился показанный результат' });
      await expect(production.selectImage(project, pkg, 0, staleResult)).rejects.toThrow(/изменился/);
      downloaded = readPackage(project, pkg)!;
      await production.selectImage(project, pkg, 0, downloaded.resultToken!);
      const selected = readPackage(project, pkg)!;
      expect(selected.keyframes.find((frame) => frame.id === frameId)).toMatchObject({ approved: false });
      expect(selected.keyframes.find((frame) => frame.id === frameId)!.imagePath).not.toBe(original);
      // Выбранная опора сразу получает свой вопрос и утверждается до подготовки следующей.
      expect(selected.pendingDecision).toMatchObject({ stage: 'keyframes_review', frame: frameId });
      expect(json(join(pkg, 'workflow.json')).request_dir).toBe('video-request');
      await production.decide(project, pkg, 'approve', '', selected.decisionToken);
      expect(readPackage(project, pkg)!.keyframes.find((frame) => frame.id === frameId)).toMatchObject({ approved: true });
    }
    expect(readPackage(project, pkg)!.keyframes.every((frame) => frame.approved)).toBe(true);
    expect(json(join(pkg, 'workflow.json')).image_requests as unknown[]).toHaveLength(2);
    expect(serviceCalls('poll').map((call) => call.generation_id)).toEqual(['image-job-1']);
    expect(submissions()).toHaveLength(2);
    for (const [path, originalHash] of originals) expect(digest(path)).toBe(originalHash);
    expect(treeHashes(join(pkg, 'video-request'))).toEqual(videoBefore);
    expect(treeHashes(join(project, 'source'))).toEqual(sourcesBefore);
    expect(treeHashes(join(project, 'assets'))).toEqual(assetsBefore);
  }, 60_000);
});
