/** Сквозной проход использует настоящие файловые инструменты и подставные CLI: провайдеры и платные сервисы не вызываются. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, resolve } from 'node:path';
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

const root = resolve(__dirname, '../..');
let directory: string;
let project: string;
let localDir: string;
let managers: AgentManager[];
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
function klingCalls(): string[][] {
  const path = join(directory, 'kling-calls.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}
function fakePaidCalls(): string[][] {
  return klingCalls().filter((args) => ['image_to_video', 'text_to_video', 'omni_ref_video', 'motion_control'].includes(args[0]) && !args.includes('--help'));
}

/** Форматы событий взяты из agent-adapters и его fake executable проверок; комментарий намеренно предшествует финальному JSON. */
function fakeAgent(provider: AgentSettings['provider']): string {
  const path = join(directory, `Подставной ${provider} CLI`);
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
    result = {schemaVersion:1,stage,request:{model:'integration-video',command:'image_to_video',parameters:{duration:9,resolution:'1080p',aspect_ratio:'16:9',imageCount:1,enable_audio:false},inputs:[{flag:'image',path:first,role:'first'},{flag:'tailImage',path:last,role:'last'}],outputs:1}};
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
function fakeKling(): string {
  const path = join(directory, 'Подставной Kling CLI');
  const model = {
    model: 'integration-video',
    arguments: [
      { name: 'prompt', required: true },
      { name: 'duration', default: '9', allowedValues: ['9', '10'] },
      { name: 'resolution', default: '1080p', allowedValues: ['1080p'] },
      { name: 'aspect_ratio', default: '16:9', allowedValues: ['16:9'] },
      { name: 'imageCount', default: '1', allowedValues: ['1'] },
      { name: 'enable_audio', default: 'false', allowedValues: ['false'] }
    ],
    inputs: [
      { name: 'first_image', required: true },
      { name: 'tail_image', required: false }
    ]
  };
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
fs.appendFileSync(${JSON.stringify(join(directory, 'kling-calls.jsonl'))},JSON.stringify(args)+'\\n');
const commands=['image_to_video','text_to_video','omni_ref_video','motion_control'];
if (args[0] === 'tool_list') { console.log(JSON.stringify({ok:true,body:{tools:commands.map(name=>({name}))}})); process.exit(0); }
if (args[0] === 'who_am_i') { console.log(JSON.stringify({ok:true,body:{availableModels:Object.fromEntries(commands.map(name=>[name,{models:[${JSON.stringify(model)}]}]))}})); process.exit(0); }
if (args[0] === 'account') { console.log(JSON.stringify({ok:true,body:{credits:{total:1000,remaining:1000}}})); process.exit(0); }
if (args[0] === 'query_tasks') { console.log(JSON.stringify({ok:true,body:{generationId:args[1],status:'FAILED',works:[]}})); process.exit(0); }
if (args[0] === 'image_to_video') {
  // Нет generationId: штатный инструмент обязан сохранить submission_unknown и запретить повтор.
  console.log(JSON.stringify({ok:true,body:{}})); process.exit(0);
}
console.error('Неожиданная команда тестового CLI'); process.exit(1);
`,
    { mode: 0o700 }
  );
  vi.stubEnv('SONGFRAME_KLING_CLI', path);
  const pricing = join(directory, 'pricing.json');
  write(pricing, { schema_version: 1, currency: 'credits', models: { 'integration-video': { base_credits: 2, per_second: { '1080p': 3 } } }, observed: [] });
  vi.stubEnv('SONGFRAME_PRICING_FILE', pricing);
  return path;
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
  directory = mkdtempSync(join(tmpdir(), 'songframe-production-integration-'));
  project = join(directory, 'Пробный клип');
  localDir = join(directory, 'Состояние приложения');
  managers = [];
  cpSync(join(root, 'tools/testdata/sample-project'), project, { recursive: true });
  // Внутренний производственный сценарий получает явно выбранные провайдеры; legacy-образец не подтверждает выбор сам.
  const projectPath = join(project, 'plan/project.json');
  const projectData = JSON.parse(readFileSync(projectPath, 'utf8'));
  write(projectPath, {
    ...projectData,
    generation: {
      video: { ...projectData.generation, provider_selected: true },
      image: { provider: 'codex', provider_selected: true }
    }
  });
});
afterEach(() => {
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
      const claude = fakeAgent('claude');
      const codex = fakeAgent('codex');
      fakeKling();
      settings.saveAgent({ provider, executablePath: provider === 'claude' ? claude : codex, model: `${provider}-text-fixture` });
      settings.saveImageAgent({ provider: 'codex', executablePath: codex, model: 'codex-images-fixture' });
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
        generateImages: (input) => images.start(input),
        collectImages: (job) => images.collect(job)
      });
      const batchesBefore = readdirSync(join(project, 'plan/batches'));
      const description = await workflow.start({ project, shot: 'M01', action: 'prepare' });
      await agentDone(agents, description.proposal!.jobId);
      expect(readdirSync(join(project, 'plan/batches'))).toEqual(batchesBefore);
      expect(fakePaidCalls()).toEqual([]);
      let view: ProductionWorkflowView = await workflow.apply(project, 'M01', undefined, description.proposal!.id);
      const pkg = view.packageDir!;
      const approve = async (): Promise<void> => {
        const current = readPackage(project, pkg)!;
        expect(current.pendingDecision?.executor).toBe('app');
        await production.decide(project, pkg, 'approve', '', current.decisionToken);
      };
      expect(view.canGenerateFrames).toBe(false);
      await approve();
      view = await workflow.generateFrames(project, 'M01', pkg);
      expect(() => agents.start({ project, task: 'Конкурирующий проход', prompt: 'Не запускайся' })).toThrow('PROJECT_BUSY');
      const imageJob = await agentDone(agents, view.proposal!.jobId);
      expect(imageJob).toMatchObject({ provider: 'codex', permissions: 'workspace-write' });
      // Без проектной модели Codex использует конфигурацию CLI, а не скрытый прежний профиль опор.
      expect(imageJob.model).toBeUndefined();
      await workflow.apply(project, 'M01', pkg, view.proposal!.id);
      expect(readPackage(project, pkg)!.keyframes.every((frame) => !frame.approved)).toBe(true);
      await approve();
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
      expect(fakePaidCalls()).toEqual([]);
      expect(agents.list(project).map((job) => job.provider)).toEqual(expect.arrayContaining([provider, 'codex']));
      const calls = agentCalls();
      expect(calls.map((call) => call.stage).sort()).toEqual(['description', 'frames', 'prompt', 'request']);
      expect(calls.filter((call) => call.stage !== 'frames').every((call) => call.provider === provider && call.cwd === project)).toBe(true);
      expect(calls.find((call) => call.stage === 'frames')!.cwd.startsWith(join(localDir, 'image-jobs'))).toBe(true);
      expect(calls.find((call) => call.stage === 'frames')!.args).toContain('workspace-write');
      expect(settings.getAgent()).toMatchObject({ provider, model: `${provider}-text-fixture` });
      // Завершённые процессы доступны новому менеджеру без повторного запуска CLI.
      const countBeforeRestart = calls.length;
      const reopened = new AgentManager(settings);
      managers.push(reopened);
      expect(reopened.list(project)).toHaveLength(4);
      expect(agentCalls()).toHaveLength(countBeforeRestart);
      expect(
        new ProductionWorkflow({
          localDir,
          agents: reopened,
          toolsRoot: () => root,
          launcher: () => launcher,
          isScenarioApproved: () => true,
          generateImages: (input) => images.start(input),
          collectImages: (job) => images.collect(job)
        }).view(project, 'M01', pkg).proposal?.status
      ).toBe('applied');
      if (provider === 'claude') {
        const quote = await production.quote(project, pkg, frozen.request!.sha256!, frozen.decisionToken);
        expect(quote).toMatchObject({ verdict: 'ok', credits: 29, balance: 1000 });
        expect(fakePaidCalls()).toEqual([]);
        await expect(production.submit(project, pkg, frozen.request!.sha256!, frozen.decisionToken)).rejects.toThrow();
        expect(fakePaidCalls()).toEqual([]);
        const submitted = await production.submit(project, pkg, frozen.request!.sha256!, frozen.decisionToken, quote.token);
        const submittedJob = await jobDone(jobs, submitted.id);
        expect(submittedJob.status, submittedJob.log).toBe('failed');
        expect(fakePaidCalls()).toHaveLength(1);
        expect(readPackage(project, pkg)!.request?.attemptStatus).toBe('submission_unknown');
        expect(readPackage(project, pkg)!.request?.generationId).toBeNull();
        await expect(production.submit(project, pkg, frozen.request!.sha256!, frozen.decisionToken, quote.token)).rejects.toThrow();
        expect(() => production.resume(project, pkg)).toThrow('ID');
        const resumed = production.resume(project, pkg, 'integration-known-generation');
        const resumedJob = await jobDone(jobs, resumed.id);
        expect(resumedJob.status, resumedJob.log).toBe('failed');
        expect(readPackage(project, pkg)!.request).toMatchObject({ generationId: 'integration-known-generation', attemptStatus: 'failed' });
        expect(readPackage(project, pkg)!.pendingDecision).toBeNull();
        expect(klingCalls().filter((args) => args[0] === 'query_tasks')).toEqual([['query_tasks', 'integration-known-generation', '--quiet']]);
        expect(fakePaidCalls()).toHaveLength(1);
      }
      expect(fileHashes(join(project, 'source'))).toEqual(sourcesBefore);
      expect(fileHashes(join(project, 'assets'))).toEqual(assetsBefore);
      expect(readFileSync(join(project, 'plan/scenes.json'))).toEqual(registryBefore);
    },
    60000
  );
});
