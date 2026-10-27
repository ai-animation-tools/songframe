/** Две опоры проходят штатные quote/Jobs/выбор; все CLI и байты загрузки локальные, сеть запрещена. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobInfo } from '@shared/types';
import { Jobs } from './jobs';
import { KeyframeImages } from './keyframe-images';
import { KlingImageProvider, KlingVideoProvider, type MediaProviderOptions } from './media-providers';
import { cliArgs, Production, readPackage } from './production';
import { PythonLauncher, type LaunchOptions } from './python-launcher';

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

/** Сохраняем настоящий launcher/runtime/toolchain; подменён только источник байтов HTTPS-ответа. */
class OfflineImagesLauncher extends PythonLauncher {
  override execute(args: string[], options: LaunchOptions = {}, currentProject?: string) {
    const bootstrap = `import io,runpy,sys,urllib.request
from pathlib import Path
payload=Path(${JSON.stringify(join(project, 'source/vehicles/boat.png'))}).read_bytes()
class LocalResponse(io.BytesIO):
    headers={'Content-Length':str(len(payload))}
def local_urlopen(url,**kwargs):
    if not url.startswith('https://fixture.invalid/original'):
        raise AssertionError('Сеть запрещена в интеграционном тесте')
    return LocalResponse(payload)
urllib.request.urlopen=local_urlopen
runpy.run_path(sys.argv.pop(1),run_name='__main__')`;
    return super.execute(['-c', bootstrap, ...args], options, currentProject);
  }
}

function calls(): string[][] {
  const path = join(directory, 'calls.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
const submissions = (): string[][] => calls().filter((args) => ['text_to_image', 'image_to_image'].includes(args[0]) && !args.includes('--help'));
function fakeKling(): void {
  const executable = join(directory, 'Подставной image CLI');
  // Discovery получает объявления сервиса, как штатный CLI; текстовая справка не подменяет их.
  const model = {
    model: 'integration-image',
    arguments: [
      { name: 'prompt', required: true },
      { name: 'resolution', allowedValues: ['1k'] },
      { name: 'image_count', allowedValues: ['1'] }
    ],
    inputs: [{ name: 'image_1', required: true }]
  };
  writeFileSync(
    executable,
    `#!${process.execPath}
const fs=require('node:fs');
const args=process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(directory, 'calls.jsonl'))},JSON.stringify(args)+'\\n');
const reply=(body)=>console.log(JSON.stringify({ok:true,body}));
if(args[0]==='tool_list') {reply({tools:[{name:'text_to_image'},{name:'image_to_image'}]});process.exit(0);}
if(args[0]==='who_am_i') {reply({availableModels:{text_to_image:{models:[${JSON.stringify(model)}]},image_to_image:{models:[${JSON.stringify(model)}]}}});process.exit(0);}
if(args[0]==='account') {reply({credits:{total:1000,remaining:1000}});process.exit(0);}
if(args[0]==='query_tasks') {reply({generationId:args[1],status:'COMPLETED',works:[{contentType:'image',url:'https://fixture.invalid/original?job='+args[1]}]});process.exit(0);}
if(args[0]==='image_to_image') {
  const counter=${JSON.stringify(join(directory, 'submit-count'))};
  const count=fs.existsSync(counter)?Number(fs.readFileSync(counter,'utf8'))+1:1;
  fs.writeFileSync(counter,String(count));
  if(fs.existsSync(${JSON.stringify(join(directory, 'unknown-outcome'))})) reply({});
  else reply({generationId:'image-job-'+count,creditsConsumed:2});
  process.exit(0);
}
console.error('Неожиданная команда fixture');process.exit(1);
`,
    { mode: 0o700 }
  );
  vi.stubEnv('SONGFRAME_KLING_CLI', executable);
  const pricing = join(directory, 'pricing.json');
  write(pricing, { schema_version: 1, currency: 'credits', models: { 'integration-image': { per_image: 2 } }, observed: [] });
  vi.stubEnv('SONGFRAME_PRICING_FILE', pricing);
}
async function done(jobs: Jobs, jobId: string): Promise<JobInfo> {
  await vi.waitFor(() => expect(jobs.get(jobId)?.status).not.toBe('running'), { timeout: 20_000, interval: 25 });
  return jobs.get(jobId)!;
}

beforeEach(() => {
  directory = mkdtempSync(join(tmpdir(), 'songframe-image-integration-'));
  project = join(directory, 'Пробный клип');
  cpSync(join(root, 'tools/testdata/sample-project'), project, { recursive: true });
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('сквозная image-ветка с локальным CLI', () => {
  it('проводит две опоры через quote/send/collect/select, восстанавливает неизвестную отправку и утверждает отдельно', async () => {
    const sourcesBefore = treeHashes(join(project, 'source'));
    const assetsBefore = treeHashes(join(project, 'assets'));
    fakeKling();
    const localDir = join(directory, 'state');
    const launcher = new OfflineImagesLauncher({ toolsRoot: root, localDir });
    const jobs = new Jobs(root, localDir, launcher);
    const production = new Production(root, jobs);
    const options: MediaProviderOptions = {
      launcher: () => launcher,
      cliArgs,
      images: new KeyframeImages({
        localDir,
        agents: {
          startImages: () => {
            throw new Error('Codex не участвует');
          }
        }
      }),
      checkCodex: async () => {
        throw new Error('Codex не участвует');
      }
    };
    const image = new KlingImageProvider(options);
    production.setMediaProviders({ image, video: new KlingVideoProvider(options) });
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
    write(join(pkg, 'video-request/request.json'), { kind: 'video', model: 'saved-video', inputs: [], parameters: {} });
    write(join(pkg, 'video-request/attempt.json'), { status: 'downloaded', generation_id: 'existing-video', downloads: [{ path: 'original.mp4' }] });
    writeFileSync(join(pkg, 'video-request/original.mp4'), 'Ранее оплаченный видеооригинал');
    const videoBefore = treeHashes(join(pkg, 'video-request'));
    await tool(['set-stage', '--dir', pkg, 'description_review', '--request-dir', 'video-request']);
    await tool(['ask', '--dir', pkg, '--stage', 'description_review', '--executor', 'app']);
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
      const staleQuote = await production.quote(project, pkg, prepared.requestSha, view.decisionToken);
      const quote = await production.quote(project, pkg, prepared.requestSha, view.decisionToken);
      expect(quote).toMatchObject({ verdict: 'ok', credits: 2, balance: 1000 });
      await expect(production.submit(project, pkg, prepared.requestSha, view.decisionToken, staleQuote.token)).rejects.toThrow(/стоимость/);
      expect(submissions()).toHaveLength(offset);
      if (frameId === 'K02') writeFileSync(join(directory, 'unknown-outcome'), 'fixture');
      const submitted = await production.submit(project, pkg, prepared.requestSha, view.decisionToken, quote.token);
      const completed = await done(jobs, submitted.id);
      expect(submissions()).toHaveLength(offset + 1);
      if (frameId === 'K02') {
        expect(completed.status, completed.log).toBe('failed');
        expect(readPackage(project, pkg)!.request).toMatchObject({ attemptStatus: 'submission_unknown', generationId: null });
        await expect(production.submit(project, pkg, prepared.requestSha, view.decisionToken, quote.token)).rejects.toThrow();
        expect(() => production.resume(project, pkg)).toThrow(/ID/);
        const resumed = await done(jobs, production.resume(project, pkg, 'image-job-2').id);
        expect(resumed.status, resumed.log).toBe('done');
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
      expect(selected.pendingDecision?.stage ?? null).toBe(frameId === 'K02' ? 'keyframes_review' : null);
      expect(json(join(pkg, 'workflow.json')).request_dir).toBe('video-request');
    }
    const beforeApproval = readPackage(project, pkg)!;
    expect(beforeApproval.keyframes.every((frame) => !frame.approved)).toBe(true);
    await production.decide(project, pkg, 'approve', '', beforeApproval.decisionToken);
    expect(readPackage(project, pkg)!.keyframes.every((frame) => frame.approved)).toBe(true);
    expect(json(join(pkg, 'workflow.json')).image_requests as unknown[]).toHaveLength(2);
    expect(
      calls()
        .filter((args) => args[0] === 'query_tasks')
        .map((args) => args[1])
    ).toEqual(['image-job-1', 'image-job-2']);
    expect(submissions()).toHaveLength(2);
    for (const [path, originalHash] of originals) expect(digest(path)).toBe(originalHash);
    expect(treeHashes(join(pkg, 'video-request'))).toEqual(videoBefore);
    expect(treeHashes(join(project, 'source'))).toEqual(sourcesBefore);
    expect(treeHashes(join(project, 'assets'))).toEqual(assetsBefore);
  }, 60_000);
});
