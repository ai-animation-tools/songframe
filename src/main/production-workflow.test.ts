/** Производственные переходы проверяются на копии sample: без CLI аккаунта, генерации и платных запросов. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { AgentJob, AgentStartInput } from '@shared/agents';
import type { ProductionStageProposal } from '@shared/production-workflow';
import { PythonLauncher, type LaunchOptions } from './python-launcher';
import { KLING_COMMANDS } from './kling-capabilities';
import { ProductionWorkflow, recoverInterruptedProductionApplies } from './production-workflow';
import { applyProductionPackage } from './production-workflow-apply';
import { checkProductionCapabilities, parseProductionProposal, type ProposalRules } from './production-proposal';
import { sourceInputDigest } from './source-input-hash';

const root = resolve(__dirname, '../..');
let work: string;
let project: string;
let localDir: string;
const sha = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const write = (path: string, value: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
};
class Manager {
  jobs: AgentJob[] = [];
  inputs: AgentStartInput[] = [];
  start(input: AgentStartInput): AgentJob {
    this.inputs.push(input);
    const job: AgentJob = {
      schemaVersion: 1,
      id: `job-${this.jobs.length}`,
      sequence: 1,
      project: input.project,
      provider: 'codex',
      task: input.task,
      permissions: 'read-only',
      inputHashes: { prompt: '', context: '' },
      status: 'running',
      phase: '',
      startedAt: '',
      finishedAt: null,
      exitCode: null,
      result: '',
      log: ''
    };
    this.jobs.push(job);
    return job;
  }
  get(id: string): AgentJob | null {
    return this.jobs.find((job) => job.id === id) ?? null;
  }
  list(project?: string): AgentJob[] {
    return this.jobs.filter((job) => !project || job.project === project);
  }
  finish(after: ProductionStageProposal): void {
    Object.assign(this.jobs.at(-1)!, { result: JSON.stringify(after), status: 'completed', exitCode: 0 });
  }
}
class Launcher extends PythonLauncher {
  calls: { name: string; args: string[] }[] = [];
  failAsk = false;
  failCapabilities = false;
  capabilityProblems: { command: string; message: string }[] = [];
  constructor() {
    super({ toolsRoot: root, localDir });
  }
  override async run(project: string | null, name: string, args: string[], options?: LaunchOptions) {
    this.calls.push({ name, args });
    if (name === 'kling_request' && args[0] === 'capabilities' && this.failCapabilities)
      return { code: 1, stdout: '', stderr: 'Каталог временно недоступен.', command: 'тестовые объявления' };
    if (name === 'kling_request' && args[0] === 'capabilities')
      return {
        code: 0,
        stdout: JSON.stringify({
          reports: KLING_COMMANDS.filter((command) => !this.capabilityProblems.some((problem) => problem.command === command)).map((command) => ({
            command,
            models: {
              'test-video': {
                arguments: { duration: { allowed: ['9'] }, resolution: { allowed: ['1080p'] } },
                slots: { first_image: { required: true }, tail_image: {} }
              }
            }
          })),
          problems: this.capabilityProblems
        }),
        stderr: '',
        command: 'тестовые объявления'
      };
    if (name === 'shot_workflow' && args[0] === 'ask' && this.failAsk) return { code: 1, stdout: '', stderr: 'Прервано согласование', command: 'тест' };
    return super.run(project, name, args, options);
  }
}
function setup() {
  const agents = new Manager();
  const launcher = new Launcher();
  let scenario = true;
  const options = {
    localDir,
    agents,
    toolsRoot: () => root,
    launcher: () => launcher,
    isScenarioApproved: () => scenario,
    generateImages: () => agents.start({ project, task: 'frames', prompt: '' }),
    collectImages: (job: AgentJob) => (JSON.parse(job.result) as { images: { id: string; path: string }[] }).images
  };
  return {
    agents,
    launcher,
    workflow: new ProductionWorkflow(options),
    options,
    revokeScenario: () => {
      scenario = false;
    }
  };
}
const description = (): ProductionStageProposal => ({
  schemaVersion: 1,
  stage: 'description',
  description: 'Лодка плывёт по спокойной реке.',
  requestSeconds: 9,
  keyframes: [
    { id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Лодка у берега', referencePaths: ['source/vehicles/boat.png'] },
    { id: 'K02', role: 'last', timeSeconds: 9, prompt: 'Лодка у пристани', referencePaths: ['source/vehicles/boat.png'] }
  ]
});
async function prepared() {
  const result = setup();
  const view = await result.workflow.start({ project, shot: 'M01', action: 'prepare' });
  result.agents.finish(description());
  const applied = await result.workflow.apply(project, 'M01', undefined, view.proposal!.id);
  return { ...result, pkg: applied.packageDir! };
}
async function decide(launcher: Launcher, pkg: string, verdict = 'approve') {
  const result = await launcher.run(project, 'shot_workflow', ['decide', '--dir', pkg, '--verdict', verdict]);
  expect(result.code, result.stderr).toBe(0);
}
function candidates() {
  return ['K01', 'K02'].map((id) => {
    const path = join(work, `${id}.png`);
    cpSync(join(project, 'source/vehicles/boat.png'), path);
    return { id, path };
  });
}
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-production-workflow-'));
  project = join(work, 'project');
  localDir = join(work, 'local');
  cpSync(join(root, 'tools/testdata/sample-project'), project, { recursive: true });
  // Производственный сценарий явно выбирает провайдеры в канонических блоках образца.
  const projectPath = join(project, 'plan/project.json');
  const projectData = JSON.parse(readFileSync(projectPath, 'utf8'));
  write(projectPath, {
    ...projectData,
    generation: {
      video: { ...projectData.generation.video, provider_selected: true },
      image: { provider: 'codex', provider_selected: true }
    }
  });
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('ProductionWorkflow', () => {
  it('дорабатывает повтор сохранённого запроса через описание только после явного запуска', async () => {
    const { workflow, agents, launcher } = setup();
    const asset = join(project, 'assets/shots/M01');
    mkdirSync(asset, { recursive: true });
    const savedPrompt = 'Лодка плывёт по реке.\r\n';
    writeFileSync(join(asset, 'prompt.txt'), savedPrompt);
    write(join(asset, 'generation-request.json'), {
      schema_version: 1,
      provider: 'kling',
      kind: 'video',
      path_base: 'asset_directory',
      command: 'image_to_video',
      model: 'test-video',
      parameters: { duration: 9, resolution: '1080p', aspect_ratio: '16:9' },
      outputs: 1,
      prompt: 'prompt.txt',
      prompt_sha256: sha(savedPrompt),
      inputs: [{ root: 'source', path: 'vehicles/boat.png', flag: 'image', sha256: sha(readFileSync(join(project, 'source/vehicles/boat.png'))) }]
    });
    // Настоящий инструмент копирует снимок без CLI аккаунта и без отправки; согласования намеренно отсутствуют.
    const regenerated = await launcher.run(project, 'regenerate_shot', ['M01', '--source', 'asset', '--executor', 'app', '--no-account', '--json']);
    expect(regenerated.code, regenerated.stderr).toBe(0);
    const pkg = JSON.parse(regenerated.stdout).package as string;
    const requestPath = join(pkg, 'request/request.json');
    const frozenBytes = readFileSync(requestPath);
    const frozenSha = sha(frozenBytes);
    const frozen = JSON.parse(frozenBytes.toString('utf8'));
    const savedFiles = [frozen.prompt, ...frozen.inputs].map((entry: { path: string }) => ({
      path: join(pkg, 'request', entry.path),
      bytes: readFileSync(join(pkg, 'request', entry.path))
    }));
    const initial = JSON.parse(readFileSync(join(pkg, 'workflow.json'), 'utf8'));
    expect(initial).toMatchObject({ description_approved: false, keyframes: [], prompt: { approved: false } });
    expect(workflow.view(project, 'M01', pkg).canRevise).toBe(false);
    const note = 'Изменить направление камеры и уточнить движение лодки';
    const decided = await launcher.run(project, 'shot_workflow', ['decide', '--dir', pkg, '--verdict', 'revise', '--note', note]);
    expect(decided.code, decided.stderr).toBe(0);
    expect(workflow.view(project, 'M01', pkg)).toMatchObject({ canRevise: true, canContinue: false, proposal: null, job: null });
    expect(agents.inputs).toHaveLength(0);
    const started = await workflow.start({ project, shot: 'M01', packageDir: pkg, action: 'revise' });
    expect(started.proposal?.stage).toBe('description');
    expect(JSON.parse(agents.inputs.at(-1)!.context!)).toMatchObject({ stage: 'description', note });
    expect(workflow.view(project, 'M01', pkg).canRevise).toBe(false);
    agents.finish(description());
    expect(workflow.view(project, 'M01', pkg)).toMatchObject({ canRevise: false, canContinue: false, proposal: { status: 'ready' } });
    await workflow.apply(project, 'M01', pkg, started.proposal!.id);
    expect(JSON.parse(readFileSync(join(pkg, 'workflow.json'), 'utf8'))).toMatchObject({
      stage: 'description_review',
      pending_decision: { stage: 'description_review', executor: 'app' }
    });
    expect(readFileSync(requestPath)).toEqual(frozenBytes);
    expect(sha(readFileSync(requestPath))).toBe(frozenSha);
    for (const file of savedFiles) expect(readFileSync(file.path)).toEqual(file.bytes);
    expect(launcher.calls.some((call) => call.args.includes('submit'))).toBe(false);
  });

  it.each([
    ['description_review', false, false, 'description'],
    ['keyframes_review', false, false, 'description'],
    ['image_request_choice', false, false, 'description'],
    ['prompt_review', false, false, 'description'],
    ['prompt_review', true, false, 'prompt'],
    ['request_choice', false, false, 'description'],
    ['request_choice', false, true, 'description'],
    ['request_choice', true, false, 'prompt'],
    ['request_choice', true, true, 'request']
  ] as const)('доработка %s при опорах=%s и промпте=%s запускает %s', async (decisionStage, framesApproved, promptIsApproved, expectedStage) => {
    const { workflow, agents, pkg } = await prepared();
    const workflowPath = join(pkg, 'workflow.json');
    const data = JSON.parse(readFileSync(workflowPath, 'utf8'));
    if (framesApproved) {
      mkdirSync(join(pkg, 'frames'), { recursive: true });
      data.keyframes = candidates().map((candidate) => {
        const path = `frames/${candidate.id}.png`;
        cpSync(candidate.path, join(pkg, path));
        return { id: candidate.id, approved: true, path, sha256: sha(readFileSync(candidate.path)) };
      });
    }
    if (promptIsApproved) {
      writeFileSync(join(pkg, 'video-prompt.txt'), 'Сохранённый видеопромпт');
      data.prompt.approved = true;
      data.approved_prompt_sha256 = sha('Сохранённый видеопромпт');
    }
    data.stage = decisionStage === 'image_request_choice' ? 'keyframes_review' : decisionStage;
    data.pending_decision = null;
    data.decision = { stage: decisionStage, verdict: 'revise', note: 'Уточнить движение' };
    write(workflowPath, data);
    const started = await workflow.start({ project, shot: 'M01', packageDir: pkg, action: 'revise' });
    expect(started.proposal?.stage).toBe(expectedStage);
    expect(JSON.parse(agents.inputs.at(-1)!.context!)).toMatchObject({ stage: expectedStage, note: 'Уточнить движение' });
  });

  it('сохраняет актуальность готового предложения после смены и удаления обложки', async () => {
    const { workflow, agents } = setup();
    const started = await workflow.start({ project, shot: 'M01', action: 'prepare' });
    agents.finish(description());
    expect(workflow.view(project, 'M01').proposal).toMatchObject({ status: 'ready', stale: false });
    const manifestPath = join(project, 'source/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.cover = { path: 'cover.png', sha256: sha('обложка'), bytes: 7 };
    manifest.updated_at = '2026-01-01T00:00:00.000Z';
    write(manifestPath, manifest);
    expect(workflow.view(project, 'M01').proposal?.stale).toBe(false);
    delete manifest.cover;
    manifest.updated_at = '2026-01-02T00:00:00.000Z';
    write(manifestPath, manifest);
    expect(workflow.view(project, 'M01').proposal?.stale).toBe(false);
    expect((await workflow.apply(project, 'M01', undefined, started.proposal!.id)).packageDir).toBeTruthy();
  });
  it.each(['references', 'track', 'idea'])('изменение %s в описи сохраняет запрет применения старого предложения', async (field) => {
    const { workflow, agents } = setup();
    const started = await workflow.start({ project, shot: 'M01', action: 'prepare' });
    agents.finish(description());
    const manifestPath = join(project, 'source/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (field === 'references') manifest.references[0].description = 'Изменённое описание референса';
    else manifest[field] = { ...manifest[field], sha256: 'b'.repeat(64) };
    write(manifestPath, manifest);
    expect(workflow.view(project, 'M01').proposal?.stale).toBe(true);
    await expect(workflow.apply(project, 'M01', undefined, started.proposal!.id)).rejects.toThrow('актуальное');
  });
  it('читает актуальный старый raw-снимок без изменения сохранённой записи', async () => {
    const { workflow, agents, options } = setup();
    await workflow.start({ project, shot: 'M01', action: 'prepare' });
    agents.finish(description());
    workflow.view(project, 'M01');
    const statePath = join(localDir, 'production-workflow', `${sha(`${project}\0M01`)}.json`);
    const stored = JSON.parse(readFileSync(statePath, 'utf8'));
    stored.hashes['source/manifest.json'] = sha(readFileSync(join(project, 'source/manifest.json')));
    write(statePath, stored);
    const before = readFileSync(statePath);
    expect(new ProductionWorkflow(options).view(project, 'M01').proposal).toMatchObject({ status: 'ready', stale: false });
    expect(readFileSync(statePath)).toEqual(before);
  });
  it('до смены обложки сохраняет только доказуемо актуальные старые снимки текущего проекта', async () => {
    const { workflow, agents, options } = setup();
    await workflow.start({ project, shot: 'M01', action: 'prepare' });
    agents.finish(description());
    workflow.view(project, 'M01');
    const directory = join(localDir, 'production-workflow');
    const statePath = join(directory, `${sha(`${project}\0M01`)}.json`);
    const stored = JSON.parse(readFileSync(statePath, 'utf8'));
    stored.hashes['source/manifest.json'] = sha(readFileSync(join(project, 'source/manifest.json')));
    write(statePath, stored);
    const untouched = [
      { ...structuredClone(stored), rules: { ...stored.rules, project: join(work, 'other-project') } },
      { ...structuredClone(stored), proposal: null },
      { ...structuredClone(stored), hashes: { ...stored.hashes, 'source/manifest.json': 'f'.repeat(64) } }
    ].map((value, index) => {
      const path = join(directory, `${sha(`другая запись ${index}`)}.json`);
      write(path, value);
      return { path, before: readFileSync(path) };
    });
    workflow.preserveSourceDecoration(project);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).hashes['source/manifest.json']).toBe(sourceInputDigest(project));
    for (const { path, before } of untouched) expect(readFileSync(path)).toEqual(before);
    const manifestPath = join(project, 'source/manifest.json');
    write(manifestPath, { ...JSON.parse(readFileSync(manifestPath, 'utf8')), cover: null, updated_at: '2026-01-03T00:00:00.000Z' });
    expect(new ProductionWorkflow(options).view(project, 'M01').proposal).toMatchObject({ status: 'ready', stale: false });
  });
  it('сохраняет read-only предложение при перезапуске и создаёт пакет только после Apply', async () => {
    const { agents, launcher, workflow, options } = setup();
    const before = readdirSync(join(project, 'plan/batches'));
    const started = await workflow.start({ project, shot: 'M01', action: 'prepare' });
    expect(readdirSync(join(project, 'plan/batches'))).toEqual(before);
    expect(agents.inputs[0].prompt).toContain('Предложение производственного этапа');
    expect(agents.inputs[0].context).not.toContain('"scenes":[');
    agents.finish(description());
    const restarted = new ProductionWorkflow(options);
    expect(restarted.view(project, 'M01').proposal?.status).toBe('ready');
    const applied = await restarted.apply(project, 'M01', undefined, started.proposal!.id);
    expect(applied.packageDir).toMatch(/M01-attempt-\d+$/);
    expect(applied.canGenerateFrames).toBe(false);
    expect(JSON.parse(readFileSync(join(applied.packageDir!, 'workflow.json'), 'utf8')).pending_decision.executor).toBe('app');
    await decide(launcher, applied.packageDir!);
    expect(restarted.view(project, 'M01', applied.packageDir!).canGenerateFrames).toBe(true);
  });
  it('новая подготовка не наследует пакет и применённое предложение, а её pending переживает перезапуск', async () => {
    const { workflow, options, agents, launcher, pkg } = await prepared();
    await decide(launcher, pkg);
    const imported = await workflow.importFrames(project, 'M01', pkg, candidates());
    await workflow.apply(project, 'M01', pkg, imported.proposal!.id);
    await decide(launcher, pkg);
    expect(workflow.view(project, 'M01', pkg).canContinue).toBe(true);
    expect(workflow.view(project, 'M01', pkg).proposal?.status).toBe('applied');
    const fresh = workflow.view(project, 'M01', undefined);
    expect(fresh).toMatchObject({
      packageDir: null,
      stage: null,
      proposal: null,
      job: null,
      canContinue: false,
      canRevise: false,
      canGenerateFrames: false,
      framePrompts: []
    });
    const before = readdirSync(join(project, 'plan/batches'));
    const started = await workflow.start({ project, shot: 'M01', action: 'prepare' });
    expect(started.packageDir).toBeNull();
    expect(started.proposal?.status).toBe('running');
    const restarted = new ProductionWorkflow(options);
    expect(restarted.view(project, 'M01', undefined).proposal?.id).toBe(started.proposal!.id);
    expect(restarted.view(project, 'M01', pkg).proposal).toBeNull();
    agents.finish(description());
    expect(restarted.view(project, 'M01').proposal?.status).toBe('ready');
    expect(readdirSync(join(project, 'plan/batches'))).toEqual(before);
    const applied = await restarted.apply(project, 'M01', undefined, started.proposal!.id);
    expect(applied.packageDir).not.toBe(pkg);
    expect(applied.proposal?.status).toBe('applied');
    expect(restarted.view(project, 'M01', undefined)).toMatchObject({ packageDir: null, proposal: null });
    expect(readFileSync(join(pkg, 'frames/K01.png'))).toEqual(readFileSync(join(project, 'source/vehicles/boat.png')));
  });
  // Полный проход последовательно запускает Python-инструменты; изолированный прогон занимает около шести секунд.
  it('проходит ручные опоры, видеопромпт и локальную подготовку нового request-NN', async () => {
    const { workflow, launcher, agents, pkg } = await prepared();
    await decide(launcher, pkg);
    const images = await workflow.importFrames(project, 'M01', pkg, candidates());
    await workflow.apply(project, 'M01', pkg, images.proposal!.id);
    expect(workflow.view(project, 'M01', pkg).canContinue).toBe(false);
    await decide(launcher, pkg);
    expect(workflow.view(project, 'M01', pkg).canContinue).toBe(true);
    const prompt = await workflow.start({ project, shot: 'M01', packageDir: pkg, action: 'continue' });
    agents.finish({ schemaVersion: 1, stage: 'prompt', prompt: 'Лодка плывёт вперёд по реке без склеек.' });
    await workflow.apply(project, 'M01', pkg, prompt.proposal!.id);
    await decide(launcher, pkg);
    launcher.failCapabilities = true;
    const agentStarts = agents.inputs.length;
    await expect(workflow.start({ project, shot: 'M01', packageDir: pkg, action: 'continue' })).rejects.toThrow('Каталог временно недоступен.');
    expect(agents.inputs).toHaveLength(agentStarts);
    launcher.failCapabilities = false;
    launcher.capabilityProblems = [{ command: 'omni_ref_video', message: 'Модели команды не объявлены.' }];
    const beforeRequestDiscovery = launcher.calls.filter((call) => call.name === 'kling_request' && call.args[0] === 'capabilities').length;
    const request = await workflow.start({ project, shot: 'M01', packageDir: pkg, action: 'continue' });
    const discovery = launcher.calls.filter((call) => call.name === 'kling_request' && call.args[0] === 'capabilities');
    expect(discovery).toHaveLength(beforeRequestDiscovery + 1);
    expect(discovery.at(-1)!.args.slice(0, 3)).toEqual(['capabilities', '--commands', KLING_COMMANDS.join(',')]);
    expect(agents.inputs.at(-1)!.context).toContain('omni_ref_video: Модели команды не объявлены.');
    agents.finish({
      schemaVersion: 1,
      stage: 'request',
      request: {
        model: 'unavailable-video',
        command: 'image_to_video',
        parameters: { duration: 9, resolution: '1080p' },
        inputs: [{ flag: 'image', path: `${pkg.slice(project.length + 1)}/frames/K01.png` }],
        outputs: 1
      }
    });
    // Несовместимый выбор агента заменяется до Apply; длительность и референс остаются прежними.
    expect(workflow.view(project, 'M01', pkg).proposal).toMatchObject({
      status: 'ready',
      after: { request: { model: 'test-video', parameters: { duration: 9, resolution: '1080p' } } }
    });
    await workflow.apply(project, 'M01', pkg, request.proposal!.id);
    expect(existsSync(join(pkg, 'request-01/request.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(pkg, 'request-01/request.json'), 'utf8'))).toMatchObject({
      provider: 'kling',
      model: 'test-video',
      parameters: { duration: 9, resolution: '1080p' }
    });
    expect(JSON.parse(readFileSync(join(pkg, 'workflow.json'), 'utf8')).pending_decision.stage).toBe('request_choice');
    expect(launcher.calls.some((call) => call.name === 'kling_request' && call.args[0] === 'submit')).toBe(false);
    const original = readFileSync(join(pkg, 'request-01/request.json'));
    await decide(launcher, pkg, 'revise');
    const retry = await workflow.start({ project, shot: 'M01', packageDir: pkg, action: 'revise' });
    agents.finish({
      schemaVersion: 1,
      stage: 'request',
      request: {
        model: 'test-video',
        command: 'image_to_video',
        parameters: { duration: 9, resolution: '1080p' },
        inputs: [{ flag: 'image', path: `${pkg.slice(project.length + 1)}/frames/K01.png` }],
        outputs: 1
      }
    });
    await workflow.apply(project, 'M01', pkg, retry.proposal!.id);
    expect(existsSync(join(pkg, 'request-02/request.json'))).toBe(true);
    expect(readFileSync(join(pkg, 'request-01/request.json'))).toEqual(original);
  }, 15000);
  it('запрещает устаревшее предложение и смену байтов кандидата', async () => {
    const { workflow, launcher, pkg } = await prepared();
    await decide(launcher, pkg);
    const files = candidates();
    const view = await workflow.importFrames(project, 'M01', pkg, files);
    writeFileSync(files[0].path, Buffer.concat([readFileSync(files[0].path), Buffer.from('изменено')]));
    expect(workflow.view(project, 'M01', pkg).proposal?.stale).toBe(true);
    await expect(workflow.apply(project, 'M01', pkg, view.proposal!.id)).rejects.toThrow('актуальное');
    workflow.discard(project, 'M01', pkg, view.proposal!.id);
    const next = await workflow.importFrames(project, 'M01', pkg, candidates());
    writeFileSync(join(pkg, 'description.md'), 'Изменённое описание');
    await expect(workflow.apply(project, 'M01', pkg, next.proposal!.id)).rejects.toThrow('актуальное');
  });
  it('доработка описания сохраняет совместимый кадр и генерирует только изменённую опору', async () => {
    const { workflow, launcher, agents, pkg } = await prepared();
    await decide(launcher, pkg);
    const imported = await workflow.importFrames(project, 'M01', pkg, candidates());
    await workflow.apply(project, 'M01', pkg, imported.proposal!.id);
    await decide(launcher, pkg);
    const revise = await workflow.start({
      project,
      shot: 'M01',
      packageDir: pkg,
      action: 'revise',
      stage: 'description',
      note: 'Лодка в конце должна развернуться'
    });
    const changed = description();
    if (changed.stage !== 'description') throw new Error('Неверная тестовая форма');
    changed.keyframes[1].prompt = 'Лодка разворачивается у пристани';
    agents.finish(changed);
    await workflow.apply(project, 'M01', pkg, revise.proposal!.id);
    const before = JSON.parse(readFileSync(join(pkg, 'workflow.json'), 'utf8'));
    expect(before.keyframes.map((frame: { approved: boolean }) => frame.approved)).toEqual([true, false]);
    await decide(launcher, pkg);
    const generated = await workflow.generateFrames(project, 'M01', pkg);
    const after = candidates()[1];
    agents.finish({ schemaVersion: 1, stage: 'frames', images: [after] });
    await workflow.apply(project, 'M01', pkg, generated.proposal!.id);
    await decide(launcher, pkg);
    expect(workflow.view(project, 'M01', pkg).canContinue).toBe(true);
  });
  it('перестановка ключей описания опор сохраняет их принятие и исходные байты', async () => {
    const { workflow, launcher, agents, pkg } = await prepared();
    await decide(launcher, pkg);
    const imported = await workflow.importFrames(project, 'M01', pkg, candidates());
    await workflow.apply(project, 'M01', pkg, imported.proposal!.id);
    await decide(launcher, pkg);
    const original = JSON.parse(readFileSync(join(pkg, 'workflow.json'), 'utf8'));
    const frames = original.keyframes.map((frame: { path: string }) => readFileSync(join(pkg, frame.path)));
    const revise = await workflow.start({
      project,
      shot: 'M01',
      packageDir: pkg,
      action: 'revise',
      stage: 'description',
      note: 'Уточнить формулировку описания, опоры прежние'
    });
    const changed = description();
    if (changed.stage !== 'description') throw new Error('Неверная тестовая форма');
    changed.description = 'Уточнённое описание без изменения принятых опор.';
    changed.keyframes = changed.keyframes.map((frame) => ({
      referencePaths: frame.referencePaths,
      prompt: frame.prompt,
      timeSeconds: frame.timeSeconds,
      role: frame.role,
      id: frame.id
    }));
    agents.finish(changed);
    await workflow.apply(project, 'M01', pkg, revise.proposal!.id);
    const current = JSON.parse(readFileSync(join(pkg, 'workflow.json'), 'utf8'));
    expect(current.keyframes.map((frame: { approved: boolean }) => frame.approved)).toEqual([true, true]);
    expect(current.approved_frames).toEqual(original.approved_frames);
    expect(current.keyframes.map((frame: { path: string }) => readFileSync(join(pkg, frame.path)))).toEqual(frames);
    await decide(launcher, pkg);
    expect(workflow.view(project, 'M01', pkg).canGenerateFrames).toBe(false);
    expect(workflow.view(project, 'M01', pkg).canContinue).toBe(true);
  });
  it('учитывает занятость пакета и не запускает Python при чтении представления', async () => {
    const { workflow, options, launcher, pkg } = await prepared();
    await decide(launcher, pkg);
    const count = launcher.calls.length;
    expect(workflow.view(project, 'M01', pkg).canGenerateFrames).toBe(true);
    const locked = new ProductionWorkflow({ ...options, isPackageBusy: () => true });
    expect(locked.view(project, 'M01', pkg).busy).toBe(true);
    await expect(locked.generateFrames(project, 'M01', pkg)).rejects.toThrow();
    await expect(locked.importFrames(project, 'M01', pkg, candidates())).rejects.toThrow();
    await expect(locked.start({ project, shot: 'M01', packageDir: pkg, action: 'prepare' })).rejects.toThrow('завершения');
    expect(launcher.calls).toHaveLength(count);
  });
  it('утверждение сценария требуется только для новой подготовки, а отменённое задание не применяется', async () => {
    const { workflow, agents, launcher, pkg, revokeScenario } = await prepared();
    await decide(launcher, pkg);
    revokeScenario();
    expect(workflow.view(project, 'M01', pkg).canPrepare).toBe(false);
    const view = await workflow.generateFrames(project, 'M01', pkg);
    Object.assign(agents.jobs.at(-1)!, { status: 'cancelled', exitCode: 1 });
    expect(workflow.view(project, 'M01', pkg).proposal?.status).toBe('failed');
    await expect(workflow.apply(project, 'M01', pkg, view.proposal!.id)).rejects.toThrow('актуальное');
  });
  it('сохраняет платный пакет и создаёт retry_of после нового Apply', async () => {
    const { workflow, launcher, agents, pkg } = await prepared();
    await decide(launcher, pkg);
    write(join(pkg, 'request/attempt.json'), { status: 'downloaded', generation_id: 'known-id' });
    writeFileSync(join(pkg, 'request/original.mp4'), 'Платный оригинал');
    const original = readFileSync(join(pkg, 'workflow.json'));
    const view = await workflow.start({ project, shot: 'M01', packageDir: pkg, action: 'revise', note: 'Новый взгляд камеры' });
    agents.finish(description());
    const applied = await workflow.apply(project, 'M01', pkg, view.proposal!.id);
    expect(applied.packageDir).not.toBe(pkg);
    expect(JSON.parse(readFileSync(join(applied.packageDir!, 'workflow.json'), 'utf8')).retry_of).toBe(pkg.slice(project.length + 1));
    expect(readFileSync(join(pkg, 'workflow.json'))).toEqual(original);
    expect(readFileSync(join(pkg, 'request/original.mp4'), 'utf8')).toBe('Платный оригинал');
  });
  it('откатывает новый пакет при сбое согласования и сохраняет готовое предложение', async () => {
    const { workflow, agents, launcher } = setup();
    const view = await workflow.start({ project, shot: 'M01', action: 'prepare' });
    agents.finish(description());
    const before = readdirSync(join(project, 'plan/batches'));
    launcher.failAsk = true;
    await expect(workflow.apply(project, 'M01', undefined, view.proposal!.id)).rejects.toThrow('Прервано');
    expect(readdirSync(join(project, 'plan/batches'))).toEqual(before);
    expect(workflow.view(project, 'M01').proposal?.status).toBe('ready');
  });
  it('не присваивает внешний пакет и не принимает неподходящий этап', async () => {
    const { workflow, launcher, pkg } = await prepared();
    await decide(launcher, pkg);
    const data = JSON.parse(readFileSync(join(pkg, 'workflow.json'), 'utf8'));
    delete data.executor;
    write(join(pkg, 'workflow.json'), data);
    expect(workflow.view(project, 'M01', pkg).managed).toBe(false);
    await expect(workflow.start({ project, shot: 'M01', packageDir: pkg, action: 'continue' })).rejects.toThrow('внешний агент');
    expect(JSON.parse(readFileSync(join(pkg, 'workflow.json'), 'utf8')).executor).toBeUndefined();
  });
});

describe('валидация и восстановление', () => {
  const rules = (): ProposalRules => ({
    project,
    stage: 'description',
    windowSeconds: 8,
    durationRule: 'min_supported_strictly_greater_than_window',
    requestSeconds: null,
    allowedPaths: ['source/vehicles/boat.png'],
    framePrompts: []
  });
  it('отклоняет неизвестные поля, посторонние пути, ID и неверную длительность', () => {
    const valid = description();
    for (const value of [
      { ...valid, arbitrary: true },
      { ...valid, requestSeconds: 8 },
      { ...valid, keyframes: [{ id: 'X', role: 'first', timeSeconds: 0, prompt: 'текст', referencePaths: ['/etc/passwd'] }] }
    ])
      expect(() => parseProductionProposal(JSON.stringify(value), rules())).toThrow();
    expect(parseProductionProposal(JSON.stringify({ ...valid, requestSeconds: 9 }), rules()).stage).toBe('description');
  });
  it('проверяет реальные объявления модели, технические поля и ближайшую поддерживаемую длительность', () => {
    const requestRules = { ...rules(), stage: 'request' as const, requestSeconds: 9 };
    const proposal: ProductionStageProposal = {
      schemaVersion: 1,
      stage: 'request',
      request: {
        model: 'current-video',
        command: 'image_to_video',
        parameters: { duration: 9, resolution: '1080p' },
        inputs: [{ flag: 'image', path: 'source/vehicles/boat.png' }],
        outputs: 1
      }
    };
    const capabilities = {
      command: 'image_to_video',
      models: {
        'current-video': {
          arguments: { duration: { allowed: ['5', '9', '10'] }, resolution: { allowed: ['720p', '1080p'] } },
          slots: { first_image: { required: true } }
        }
      }
    };
    const settings = { resolution: '1080p', aspect_ratio: '16:9' };
    expect(() => checkProductionCapabilities(proposal, requestRules, capabilities, settings)).not.toThrow();
    expect(() => checkProductionCapabilities(proposal, requestRules, { ...capabilities, command: 'text_to_video' }, settings)).toThrow(
      'не объявлена для команды'
    );
    const unknown = structuredClone(proposal);
    if (unknown.stage !== 'request') throw new Error('Неверная форма');
    unknown.request.parameters.unknown_flag = true;
    expect(() => checkProductionCapabilities(unknown, requestRules, capabilities, settings)).toThrow('не объявлен');
    const longer = structuredClone(proposal);
    if (longer.stage !== 'request') throw new Error('Неверная форма');
    longer.request.parameters.duration = 10;
    expect(() => checkProductionCapabilities(longer, requestRules, capabilities, settings)).toThrow('ближайшей');
    const prompt = structuredClone(proposal);
    if (prompt.stage !== 'request') throw new Error('Неверная форма');
    prompt.request.parameters.prompt = 'Подмена принятого текста';
    expect(() => parseProductionProposal(JSON.stringify(prompt), requestRules)).toThrow('техническое поле');
    const path = structuredClone(proposal);
    if (path.stage !== 'request') throw new Error('Неверная форма');
    path.request.inputs[0].path = '/etc/passwd';
    expect(() => parseProductionProposal(JSON.stringify(path), requestRules)).toThrow('объявленный исходник');
  });
  it('заменяет предпочтение video-3 на video-4 для окна 24 секунды без сокращения запроса 25 секунд', () => {
    const requestRules = { ...rules(), stage: 'request' as const, windowSeconds: 24, requestSeconds: 25 };
    const proposal: ProductionStageProposal = {
      schemaVersion: 1,
      stage: 'request',
      request: {
        model: 'video-3',
        command: 'image_to_video',
        parameters: { duration: 25, resolution: '1080p' },
        inputs: [{ flag: 'image', path: 'source/vehicles/boat.png', role: 'first' }],
        outputs: 1
      }
    };
    const capabilities = {
      command: 'image_to_video',
      models: {
        'video-3': {
          arguments: { duration: { allowed: ['5', '10', '15'] }, resolution: { allowed: ['1080p'] } },
          slots: { first_image: { required: true } }
        },
        'video-4': {
          arguments: { duration: { allowed: ['5', '10', '25', '30'] }, resolution: { allowed: ['1080p'] } },
          slots: { first_image: { required: true } }
        }
      }
    };
    const settings = { model: 'video-3', resolution: '1080p' };
    const parsed = parseProductionProposal(JSON.stringify(proposal), requestRules);
    expect(() => checkProductionCapabilities(parsed, requestRules, capabilities, settings)).not.toThrow();
    expect(parsed).toMatchObject({ request: { model: 'video-4', parameters: { duration: 25, resolution: '1080p' }, inputs: proposal.request.inputs } });

    const incompatible = structuredClone(proposal);
    expect(() =>
      checkProductionCapabilities(incompatible, requestRules, { ...capabilities, models: { 'video-3': capabilities.models['video-3'] } }, settings)
    ).toThrow('25');
    expect(incompatible.request).toEqual(proposal.request);
    const shortened = structuredClone(proposal);
    shortened.request.parameters.duration = 15;
    expect(() => parseProductionProposal(JSON.stringify(shortened), requestRules)).toThrow('отличается от согласованного плана');
  });
  it('сохраняет совместимое предпочтение модели, даже если агент предложил другую', () => {
    const requestRules = { ...rules(), stage: 'request' as const, requestSeconds: 9 };
    const proposal: ProductionStageProposal = {
      schemaVersion: 1,
      stage: 'request',
      request: {
        model: 'video-4',
        command: 'image_to_video',
        parameters: { duration: 9, resolution: '1080p' },
        inputs: [{ flag: 'image', path: 'source/vehicles/boat.png' }],
        outputs: 1
      }
    };
    const model = { arguments: { duration: { allowed: ['5', '9', '15'] }, resolution: { allowed: ['1080p'] } }, slots: { first_image: { required: true } } };
    checkProductionCapabilities(
      proposal,
      requestRules,
      { command: 'image_to_video', models: { 'video-4': model, 'video-3': model } },
      { model: 'video-3', resolution: '1080p' }
    );
    expect(proposal.request.model).toBe('video-3');
    expect(proposal.request.parameters.duration).toBe(9);
  });
  it('подбирает другую модель, если предпочтение нарушает ближайшую согласованную длительность', () => {
    const requestRules = { ...rules(), stage: 'request' as const, requestSeconds: 10 };
    const proposal: ProductionStageProposal = {
      schemaVersion: 1,
      stage: 'request',
      request: { model: 'video-4', command: 'text_to_video', parameters: { duration: 10, resolution: '1080p' }, inputs: [], outputs: 1 }
    };
    const capabilities = {
      command: 'text_to_video',
      models: {
        'video-3': { arguments: { duration: { allowed: ['9', '10'] }, resolution: { allowed: ['1080p'] } }, slots: {} },
        'video-4': { arguments: { duration: { allowed: ['10'] }, resolution: { allowed: ['1080p'] } }, slots: {} }
      }
    };
    checkProductionCapabilities(proposal, requestRules, capabilities, { model: 'video-3', resolution: '1080p' });
    expect(proposal.request.model).toBe('video-4');
    expect(proposal.request.parameters.duration).toBe(10);
  });
  it('включает video options проекта в предложение и отклоняет конфликт вместо замены настроек', () => {
    const requestRules = { ...rules(), stage: 'request' as const, requestSeconds: 9 };
    const proposal: ProductionStageProposal = {
      schemaVersion: 1,
      stage: 'request',
      request: { model: 'video', command: 'text_to_video', parameters: { duration: 9, resolution: '1080p' }, inputs: [], outputs: 1 }
    };
    const capabilities = {
      command: 'text_to_video',
      models: {
        video: {
          arguments: { duration: { allowed: ['9'] }, resolution: { allowed: ['1080p'] }, enable_audio: { allowed: ['true', 'false'], default: 'true' } },
          slots: {}
        }
      }
    };
    const settings = { resolution: '1080p', options: { enableAudio: false } };
    checkProductionCapabilities(proposal, requestRules, capabilities, settings);
    expect(proposal.request.parameters.enable_audio).toBe(false);
    proposal.request.parameters.enable_audio = true;
    expect(() => checkProductionCapabilities(proposal, requestRules, capabilities, settings)).toThrow('конфликтует');
  });
  it('восстанавливает байты и отсутствие новых файлов после ошибки', async () => {
    const pkg = join(project, 'plan/batches/test-package');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'description.md'), 'Исходное описание');
    await expect(
      applyProductionPackage(localDir, project, pkg, async () => {
        writeFileSync(join(pkg, 'description.md'), 'Изменено');
        writeFileSync(join(pkg, 'new.txt'), 'Новый файл');
        throw new Error('Ошибка');
      })
    ).rejects.toThrow('Ошибка');
    expect(readFileSync(join(pkg, 'description.md'), 'utf8')).toBe('Исходное описание');
    expect(existsSync(join(pkg, 'new.txt'))).toBe(false);
  });
  it('восстанавливает прерванную замену при следующем запуске', () => {
    const pkg = join(project, 'plan/batches/test-package');
    mkdirSync(pkg);
    writeFileSync(join(pkg, 'description.md'), 'Незавершённая запись');
    const directory = join(localDir, 'production-apply', sha(`${project}\0${pkg}`));
    write(join(directory, 'pending.json'), { schemaVersion: 1, project, packageDir: 'plan/batches/test-package', existed: true });
    mkdirSync(join(directory, 'package'));
    writeFileSync(join(directory, 'package/description.md'), 'Резерв');
    recoverInterruptedProductionApplies(localDir);
    expect(readFileSync(join(pkg, 'description.md'), 'utf8')).toBe('Резерв');
    expect(existsSync(join(directory, 'pending.json'))).toBe(false);
  });
  it('не меняет пакет с признаком отправки даже без журнала attempt.json', async () => {
    const pkg = join(project, 'plan/batches/legacy-paid');
    write(join(pkg, 'workflow.json'), { shot: 'M01', stage: 'downloaded' });
    await expect(
      applyProductionPackage(localDir, project, pkg, async () => {
        throw new Error('Не должно выполняться');
      })
    ).rejects.toThrow('платной отправки');
    expect(JSON.parse(readFileSync(join(pkg, 'workflow.json'), 'utf8')).stage).toBe('downloaded');
  });
  it('не восстанавливает резерв поверх платной попытки и сохраняет журнал для разбора', () => {
    const pkg = join(project, 'plan/batches/paid-package');
    write(join(pkg, 'request-01/attempt.json'), { status: 'submitted', generation_id: 'known-id' });
    const directory = join(localDir, 'production-apply', sha(`${project}\0${pkg}`));
    write(join(directory, 'pending.json'), { schemaVersion: 1, project, packageDir: 'plan/batches/paid-package', existed: false });
    expect(() => recoverInterruptedProductionApplies(localDir)).toThrow('платную попытку');
    expect(existsSync(join(directory, 'pending.json'))).toBe(true);
    expect(JSON.parse(readFileSync(join(pkg, 'request-01/attempt.json'), 'utf8')).generation_id).toBe('known-id');
  });
});
