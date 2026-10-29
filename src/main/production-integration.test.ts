/** Сквозной проход использует настоящие файловые инструменты и подставные CLI: провайдеры и платные сервисы не вызываются. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join, relative, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentJob, AgentSettings } from '@shared/agents';
import type { JobInfo } from '@shared/types';
import type { ProductionWorkflowView } from '@shared/production-workflow';
import { AgentManager } from './agent-manager';
import { Jobs } from './jobs';
import { KeyframeImages } from './keyframe-images';
import { Production, readPackage } from './production';
import { ProductionWorkflow } from './production-workflow';
import { PythonLauncher } from './python-launcher';
import { SettingsStore } from './settings';
import { registerTestAgentProvider, registerTestMediaProvider, TEST_AGENT_PROVIDER } from './testing/media-provider';

const root = resolve(__dirname, '../..');
let directory: string;
let project: string;
let localDir: string;
let managers: AgentManager[];
let restoreProvider: () => void;
const IMAGE_SHA = 'f'.repeat(64);
const write = (path: string, value: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
};
function fileHashes(path: string): Record<string, string> {
  const entries: [string, string][] = [];
  const visit = (current: string): void => {
    for (const item of readdirSync(current, { withFileTypes: true })) {
      const child = join(current, item.name);
      if (item.isDirectory()) visit(child);
      else if (item.isFile()) entries.push([relative(path, child), createHash('sha256').update(readFileSync(child)).digest('hex')]);
    }
  };
  visit(path);
  return Object.fromEntries(entries.sort(([left], [right]) => left.localeCompare(right)));
}
interface Invocation {
  provider: string;
  args: string[];
  cwd: string;
  stage: string;
}
function agentCalls(): Invocation[] {
  const path = join(directory, 'agent-calls.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
/** Журнал тестового сервиса провайдера `test`: по нему считаются отправки и опросы. */
function serviceCalls(action?: string): Record<string, unknown>[] {
  const path = join(directory, 'service', 'calls.jsonl');
  if (!existsSync(path)) return [];
  return readFileSync(path, 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter((call) => !action || call.action === action);
}
const paidCalls = (): Record<string, unknown>[] => serviceCalls('submit');

function fakeAgent(provider: AgentSettings['provider']): string {
  const bin = join(directory, 'Подставные CLI');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, provider);
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require('node:fs');
const path = require('node:path');
const provider = ${JSON.stringify(provider)};
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log(provider === 'codex' ? 'codex-cli 0.159.2' : '2.1.0 (Claude Code)'); process.exit(0); }
if (args[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
if (args[0] === 'auth') { console.log(JSON.stringify({loggedIn:true})); process.exit(0); }
let input = '';
const emit = (event) => process.stdout.write(JSON.stringify(event)+'\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  const marker = '\\n\\nДополнительный контекст:\\n';
  const context = JSON.parse(input.slice(input.lastIndexOf(marker) + marker.length));
  const stage = context.stage;
  fs.appendFileSync(${JSON.stringify(join(directory, 'agent-calls.jsonl'))}, JSON.stringify({provider,args,cwd:process.cwd(),stage})+'\\n');
  let result;
  if (stage === 'frames') {
    if (provider !== 'codex' || args[args.indexOf('--sandbox')+1] !== 'workspace-write') throw new Error('Кандидаты требуют отдельного маршрута Codex');
    result = {schemaVersion:1,stage,images:context.frames.map((frame) => {
      if (!frame.referencePaths[0] || path.isAbsolute(frame.referencePaths[0])) throw new Error('Нужна рабочая копия референса');
      const target = frame.id+'.png';
      fs.copyFileSync(frame.referencePaths[0],target);
      return {id:frame.id,path:target};
    }).reverse()};
  } else if (stage === 'description') result = {schemaVersion:1,stage,description:'Лодка плывёт по реке, сохраняя внешность и направление движения.',requestSeconds:9,keyframes:[
    {id:'K01',role:'first',timeSeconds:0,prompt:'Синяя лодка в начале реки.',referencePaths:['source/vehicles/boat.png']},
    {id:'K02',role:'last',timeSeconds:9,prompt:'Та же лодка в конце реки.',referencePaths:['source/vehicles/boat.png']}
  ]};
  else if (stage === 'prompt') result = {schemaVersion:1,stage,prompt:'Один непрерывный общий план: синяя лодка плывёт по реке вперёд 9 секунд. Лодка и берега сохраняют внешний вид. В конце движение замирает.'};
  else if (stage === 'request') {
    const first = context.allowedPaths.find((value) => value.endsWith('/frames/K01.png'));
    const last = context.allowedPaths.find((value) => value.endsWith('/frames/K02.png'));
    if (!first || !last) throw new Error('Утверждённые опоры не переданы');
    result = {schemaVersion:1,stage,request:{model:'integration-video',command:'image_to_video',parameters:{duration:9,resolution:'1080p',aspect_ratio:'16:9'},inputs:[{flag:'input',slot:'first_image',path:first,role:'first'},{flag:'input',slot:'tail_image',path:last,role:'last'}],outputs:1}};
  } else throw new Error('Неизвестный этап '+stage);
  const final = JSON.stringify(result);
  if (provider === 'codex') {
    emit({type:'thread.started',thread_id:'integration-codex'});
    emit({type:'item.completed',item:{id:'commentary',type:'agent_message',text:'Проверяю переданный производственный контекст.'}});
    emit({type:'item.completed',item:{id:'final',type:'agent_message',text:final}});
    emit({type:'turn.completed'});
  } else {
    emit({type:'system',subtype:'init',session_id:'integration-claude'});
    emit({type:'stream_event',event:{delta:{type:'text_delta',text:'Проверяю переданный производственный контекст.'}}});
    emit({type:'result',subtype:'success',is_error:false,result:final,session_id:'integration-claude'});
  }
});
`,
    { mode: 0o700 }
  );
  return path;
}

/** Discovery, account и query повторяют контракт CLI; исполняемый файл только пишет локальный счётчик. */
/** Платный провайдер — тестовый `test`: модель видео и неизвестный исход отправки задаёт конфигурация его сервиса. */
function fakeService(): void {
  const model = {
    arguments: {
      prompt: { required: true },
      duration: { default: '9', allowed: ['9', '10'] },
      resolution: { default: '1080p', allowed: ['1080p'] },
      aspect_ratio: { default: '16:9', allowed: ['16:9'] }
    },
    slots: { first_image: { required: true }, tail_image: { required: false } },
    limits: {}
  };
  const service = join(directory, 'service');
  write(join(service, 'service.json'), {
    reports: { video: ['image_to_video', 'text_to_video'].map((command) => ({ command, models: { 'integration-video': model } })) },
    // Ответ без ID задания: штатный инструмент обязан сохранить submission_unknown и запретить повтор.
    submit: 'unknown'
  });
  vi.stubEnv('SONGFRAME_TEST_MEDIA_SERVICE', join(service, 'service.json'));
  const pricing = join(directory, 'pricing.json');
  write(pricing, { schema_version: 1, currency: 'credits', models: { 'integration-video': { base_credits: 2, per_second: { '1080p': 3 } } }, observed: [] });
  vi.stubEnv('SONGFRAME_PRICING_FILE', pricing);
}
async function agentDone(agents: AgentManager, jobId: string): Promise<AgentJob> {
  await vi.waitFor(() => expect(agents.get(jobId)?.status).not.toBe('running'), { timeout: 10000, interval: 20 });
  const job = agents.get(jobId)!;
  expect(job.status, job.message).toBe('completed');
  expect(job.exitCode).toBe(0);
  // Прогресс не должен приклеиваться к итоговому документу ни у одного провайдера.
  expect(JSON.parse(job.result)).toMatchObject({ schemaVersion: 1 });
  return job;
}
async function jobDone(jobs: Jobs, jobId: string): Promise<JobInfo> {
  await vi.waitFor(() => expect(jobs.get(jobId)?.status).not.toBe('running'), { timeout: 15000, interval: 25 });
  return jobs.get(jobId)!;
}

beforeEach(() => {
  const restorePaid = registerTestMediaProvider();
  const restoreAgent = registerTestAgentProvider();
  restoreProvider = () => {
    restoreAgent();
    restorePaid();
  };
  directory = mkdtempSync(join(tmpdir(), 'songframe-production-integration-'));
  project = join(directory, 'Пробный клип');
  localDir = join(directory, 'Состояние приложения');
  managers = [];
  cpSync(join(root, 'tools/testdata/sample-project'), project, { recursive: true });
  // Производственный сценарий явно выбирает провайдеры в канонических блоках образца.
  const projectPath = join(project, 'plan/project.json');
  const projectData = JSON.parse(readFileSync(projectPath, 'utf8'));
  write(projectPath, {
    ...projectData,
    generation: {
      video: { ...projectData.generation.video, provider_selected: true },
      image: { provider: TEST_AGENT_PROVIDER, provider_selected: true }
    }
  });
});
afterEach(() => {
  restoreProvider();
  for (const agents of managers) agents.shutdown();
  vi.unstubAllEnvs();
  rmSync(directory, { recursive: true, force: true });
});

describe.skipIf(process.platform !== 'linux')('сквозное производство с подставными CLI', () => {
  it.each(['claude', 'codex'] as const)(
    'проходит описание, опоры, промпт и замороженный запрос с текстовым %s',
    async (provider) => {
      const sourcesBefore = fileHashes(join(project, 'source'));
      const assetsBefore = fileHashes(join(project, 'assets'));
      const registryBefore = readFileSync(join(project, 'plan/scenes.json'));
      const settings = new SettingsStore(localDir);
      const bin = dirname(fakeAgent('claude'));
      fakeAgent('codex');
      vi.stubEnv('PATH', bin + delimiter + (process.env.PATH ?? ''));
      fakeService();
      settings.saveAgent({ provider, model: `${provider}-text-fixture` });
      const agents = new AgentManager(settings, { timeoutMs: 10000 });
      managers.push(agents);
      const launcher = new PythonLauncher({ toolsRoot: root, localDir });
      const jobs = new Jobs(root, localDir, launcher);
      const production = new Production(root, jobs);
      const images = new KeyframeImages({
        localDir,
        agents,
        validateImage: (path) => readFileSync(path).equals(readFileSync(join(project, 'source/vehicles/boat.png')))
      });
      const workflow = new ProductionWorkflow({
        localDir,
        agents,
        toolsRoot: () => root,
        launcher: () => launcher,
        isScenarioApproved: () => true,
        isPackageBusy: (project, packageDir) => production.isBusy(project, packageDir),
        generateImages: (input) =>
          images.start(input, { provider: TEST_AGENT_PROVIDER, requestSha: IMAGE_SHA, agent: settings.getImageAgent(TEST_AGENT_PROVIDER) }),
        collectImages: (job) => images.collect(job, images.getRequestSha(job))
      });
      const batchesBefore = readdirSync(join(project, 'plan/batches'));
      const description = await workflow.start({ project, shot: 'M01', action: 'prepare' });
      await agentDone(agents, description.proposal!.jobId);
      expect(readdirSync(join(project, 'plan/batches'))).toEqual(batchesBefore);
      expect(paidCalls()).toEqual([]);
      let view: ProductionWorkflowView = await workflow.apply(project, 'M01', undefined, description.proposal!.id);
      const pkg = view.packageDir!;
      const approve = async (): Promise<void> => {
        const current = readPackage(project, pkg)!;
        expect(current.pendingDecision).not.toBeNull();
        await production.decide(project, pkg, 'approve', '', current.decisionToken);
      };
      expect(view.canGenerateFrames).toBe(false);
      await approve();
      // Опоры создаются по одной: вопрос о каждой задаётся сразу, следующая создаётся после решения.
      const frameIds = workflow.view(project, 'M01', pkg).framePrompts.map((frame) => frame.id);
      expect(frameIds.length).toBeGreaterThan(1);
      for (const [index, id] of frameIds.entries()) {
        expect(workflow.view(project, 'M01', pkg).nextFrame).toBe(id);
        view = await workflow.generateFrames(project, 'M01', pkg);
        if (!index) expect(() => agents.start({ project, task: 'Конкурирующий проход', prompt: 'Не запускайся' })).toThrow('PROJECT_BUSY');
        const imageJob = await agentDone(agents, view.proposal!.jobId);
        expect(imageJob).toMatchObject({ provider: 'codex', permissions: 'workspace-write' });
        // Без проектной модели программа-агент использует конфигурацию CLI, а не скрытый прежний профиль опор.
        expect(imageJob.model).toBeUndefined();
        await workflow.apply(project, 'M01', pkg, view.proposal!.id);
        expect(readPackage(project, pkg)!.pendingDecision?.frame).toBe(id);
        await approve();
      }
      view = await workflow.start({ project, shot: 'M01', packageDir: pkg, action: 'continue' });
      await agentDone(agents, view.proposal!.jobId);
      await workflow.apply(project, 'M01', pkg, view.proposal!.id);
      await approve();
      view = await workflow.start({ project, shot: 'M01', packageDir: pkg, action: 'continue' });
      await agentDone(agents, view.proposal!.jobId);
      await workflow.apply(project, 'M01', pkg, view.proposal!.id);
      const frozen = readPackage(project, pkg)!;
      expect(frozen.pendingDecision?.stage).toBe('request_choice');
      expect(frozen.request?.attemptStatus).toBe('prepared');
      expect(frozen.request?.sha256).toMatch(/^[a-f0-9]{64}$/);
      expect(paidCalls()).toEqual([]);
      expect(agents.list(project).map((job) => job.provider)).toEqual(expect.arrayContaining([provider, 'codex']));
      const calls = agentCalls();
      // Отдельный проход изображений на каждую опору.
      expect(calls.map((call) => call.stage).sort()).toEqual(['description', ...frameIds.map(() => 'frames'), 'prompt', 'request'].sort());
      expect(calls.filter((call) => call.stage !== 'frames').every((call) => call.provider === provider && call.cwd === project)).toBe(true);
      expect(calls.find((call) => call.stage === 'frames')!.cwd.startsWith(join(localDir, 'image-jobs'))).toBe(true);
      expect(calls.find((call) => call.stage === 'frames')!.args).toContain('workspace-write');
      expect(settings.getAgent()).toMatchObject({ provider, model: `${provider}-text-fixture` });
      // Завершённые процессы доступны новому менеджеру без повторного запуска CLI.
      const countBeforeRestart = calls.length;
      const reopened = new AgentManager(settings);
      managers.push(reopened);
      expect(reopened.list(project)).toHaveLength(countBeforeRestart);
      expect(agentCalls()).toHaveLength(countBeforeRestart);
      expect(
        new ProductionWorkflow({
          localDir,
          agents: reopened,
          toolsRoot: () => root,
          launcher: () => launcher,
          isScenarioApproved: () => true,
          generateImages: (input) =>
            images.start(input, { provider: TEST_AGENT_PROVIDER, requestSha: IMAGE_SHA, agent: settings.getImageAgent(TEST_AGENT_PROVIDER) }),
          collectImages: (job) => images.collect(job, images.getRequestSha(job))
        }).view(project, 'M01', pkg).proposal?.status
      ).toBe('applied');
      if (provider === 'claude') {
        const quote = await production.quote(project, pkg, frozen.request!.sha256!, frozen.decisionToken);
        expect(quote).toMatchObject({ verdict: 'ok', credits: 29, balance: 1000 });
        expect(paidCalls()).toEqual([]);
        await expect(production.submit(project, pkg, frozen.request!.sha256!, frozen.decisionToken)).rejects.toThrow();
        expect(paidCalls()).toEqual([]);
        const submitted = await production.submit(project, pkg, frozen.request!.sha256!, frozen.decisionToken, quote.token);
        const submittedJob = await jobDone(jobs, submitted.id);
        expect(submittedJob.status, submittedJob.log).toBe('failed');
        expect(paidCalls()).toHaveLength(1);
        expect(readPackage(project, pkg)!.request?.attemptStatus).toBe('submission_unknown');
        expect(readPackage(project, pkg)!.request?.generationId).toBeNull();
        await expect(production.submit(project, pkg, frozen.request!.sha256!, frozen.decisionToken, quote.token)).rejects.toThrow();
        expect(() => production.resume(project, pkg)).toThrow('историю генераций');
        // Генерации нет в истории сервиса: пользователь отмечает это, и попытка снова ждёт подтверждения отправки.
        await production.markNotCreated(project, pkg);
        expect(readPackage(project, pkg)!.request).toMatchObject({ generationId: null, attemptStatus: 'prepared' });
        expect(readPackage(project, pkg)!.pendingDecision?.stage).toBe('request_choice');
        await expect(production.submit(project, pkg, frozen.request!.sha256!, frozen.decisionToken, quote.token)).rejects.toThrow();
        expect(serviceCalls('poll')).toEqual([]);
        expect(paidCalls()).toHaveLength(1);
      }
      expect(fileHashes(join(project, 'source'))).toEqual(sourcesBefore);
      expect(fileHashes(join(project, 'assets'))).toEqual(assetsBefore);
      expect(readFileSync(join(project, 'plan/scenes.json'))).toEqual(registryBefore);
    },
    60000
  );
});
