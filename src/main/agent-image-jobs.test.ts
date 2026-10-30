/** Подставной Codex проверяет маршрут изображений, аргументы и историю без доступа к провайдерам. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentJob } from '@shared/agents';
import { AgentManager } from './agent-manager';
import { KeyframeImages } from './keyframe-images';
import { SettingsStore } from './settings';
import { registerTestAgentProvider, TEST_AGENT_PROVIDER } from './testing/media-provider';

let restoreProvider: () => void;
beforeAll(() => {
  restoreProvider = registerTestAgentProvider();
});
afterAll(() => restoreProvider());

const pngBase64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=';
let work: string;
let project: string;
let localDir: string;
let candidateDir: string;
let settings: SettingsStore;
let managers: AgentManager[];
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-image-jobs-'));
  project = join(work, 'Клип');
  localDir = join(work, 'state');
  mkdirSync(join(project, 'plan'), { recursive: true });
  writeFileSync(join(project, 'plan/project.json'), '{"name":"Клип"}');
  writeFileSync(join(project, 'README.md'), 'Не изменять исходный проект.');
  candidateDir = join(localDir, 'image-jobs', 'candidate-fixture');
  mkdirSync(candidateDir, { recursive: true });
  settings = new SettingsStore(localDir);
  managers = [];
});
afterEach(() => {
  for (const manager of managers) manager.shutdown();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  rmSync(work, { recursive: true, force: true });
});

function manager(): AgentManager {
  const value = new AgentManager(settings, { timeoutMs: 4000 });
  managers.push(value);
  return value;
}
/** Фальшивый codex лежит в каталоге с пробелами первым в PATH, раньше настоящего CLI из ~/.local/bin. */
function fakeCodex(wait = false): string {
  const bin = join(work, 'bin с пробелами');
  mkdirSync(bin, { recursive: true });
  const path = join(bin, 'codex');
  writeFileSync(
    path,
    `#!${process.execPath}
const fs = require('node:fs');
const args = process.argv.slice(2);
if (args[0] === '--version') { console.log('codex-cli 0.159.2'); process.exit(0); }
if (args[0] === 'login') { console.error('Logged in using ChatGPT'); process.exit(0); }
let input = '';
const send = (value) => process.stdout.write(JSON.stringify(value)+'\\n');
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => input += chunk);
process.stdin.on('end', () => {
  fs.appendFileSync(${JSON.stringify(join(work, 'invocations.jsonl'))}, JSON.stringify({args,cwd:process.cwd(),input})+'\\n');
  send({type:'thread.started',thread_id:'fixture-images'});
  send({type:'turn.started'});
  if (${wait}) { setInterval(() => {}, 1000); return; }
  if (args[args.indexOf('--sandbox')+1] === 'workspace-write') fs.writeFileSync('K01.png',Buffer.from(${JSON.stringify(pngBase64)},'base64'));
  send({type:'item.completed',item:{id:'final',type:'agent_message',text:JSON.stringify({schemaVersion:1,stage:'frames',images:[{id:'K01',path:'K01.png'}]})}});
  send({type:'turn.completed'});
});
`,
    { mode: 0o700 }
  );
  vi.stubEnv('PATH', bin + delimiter + (process.env.PATH ?? ''));
  return path;
}
function imageProject(image: Record<string, unknown>): void {
  writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ name: 'Клип', generation: { image } }));
}
function invocations(): { args: string[]; cwd: string; input: string }[] {
  const path = join(work, 'invocations.jsonl');
  return existsSync(path)
    ? readFileSync(path, 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line))
    : [];
}
async function done(value: AgentManager, id: string): Promise<AgentJob> {
  await vi.waitFor(() => expect(value.get(id)?.status).not.toBe('running'), { timeout: 4000, interval: 10 });
  return value.get(id)!;
}
/** Программа изображений задаётся провайдером изображений; здесь — подставной Codex CLI. */
const IMAGE_AGENT = { provider: 'codex' as const };
const input = (project: string) => ({ project, task: 'Опоры S01', prompt: 'Нарисуй K01', context: '{"stage":"frames"}' });
const projectHashes = (): string[] =>
  ['plan/project.json', 'README.md'].map((path) =>
    createHash('sha256')
      .update(readFileSync(join(project, path)))
      .digest('hex')
  );

describe.skipIf(process.platform !== 'linux')('маршрут Codex изображений', () => {
  it('запускает найденный в PATH Codex при выбранном Claude и передаёт точный sandbox/cwd/model задания', async () => {
    fakeCodex();
    const selected = { provider: 'claude' as const, model: 'личная модель Claude' };
    settings.saveAgent(selected);
    const before = projectHashes();
    const value = manager();
    const job = value.startImages(input(project), candidateDir, { ...IMAGE_AGENT, model: 'модель Codex с пробелами' });
    expect(job).toMatchObject({ provider: 'codex', model: 'модель Codex с пробелами', permissions: 'workspace-write' });
    expect(await done(value, job.id)).toMatchObject({ status: 'completed', exitCode: 0 });
    expect(invocations()).toHaveLength(1);
    const invocation = invocations()[0];
    expect(invocation.cwd).toBe(candidateDir);
    expect(invocation.args).toEqual([
      '-a',
      'never',
      'exec',
      '--json',
      '--sandbox',
      'workspace-write',
      '--skip-git-repo-check',
      '--color',
      'never',
      '--model',
      'модель Codex с пробелами',
      '-'
    ]);
    // Инструкция записи кандидатов сохраняется целиком и не превращается в редактируемую подпись UI.
    expect(invocation.input).toBe(
      'Создай только запрошенные изображения в текущей рабочей папке кандидатов. Не изменяй материалы исходного проекта, не выполняй commit/push и не отправляй запросы сервисам генерации. Верни финальный JSON в запрошенном формате.\n\nЗадача:\nНарисуй K01\n\nДополнительный контекст:\n{"stage":"frames"}'
    );
    expect(readFileSync(join(candidateDir, 'K01.png'))).toEqual(Buffer.from(pngBase64, 'base64'));
    expect(settings.getAgent()).toEqual(selected);
    expect(settings.getProviderAgent('codex')).toBeNull();
    expect(projectHashes()).toEqual(before);
    expect(manager().get(job.id)).toMatchObject({ permissions: 'workspace-write', provider: 'codex', status: 'completed' });
  });

  it('generic start остаётся read-only в папке проекта и не рисует PNG', async () => {
    fakeCodex();
    settings.saveAgent({ provider: 'codex', model: 'модель Codex с пробелами' });
    const before = projectHashes();
    const value = manager();
    const job = value.start(input(project));
    expect(await done(value, job.id)).toMatchObject({ permissions: 'read-only', status: 'completed' });
    expect(invocations()[0].cwd).toBe(project);
    expect(invocations()[0].args).toContain('read-only');
    expect(invocations()[0].args).not.toContain('workspace-write');
    expect(existsSync(join(project, 'K01.png'))).toBe(false);
    expect(projectHashes()).toEqual(before);
    expect(manager().get(job.id)?.permissions).toBe('read-only');
  });

  it('модель изображений используется только для image job, модель текстового Codex туда не переносится', async () => {
    fakeCodex();
    settings.saveAgent({ provider: 'codex', model: 'text-codex-model' });
    const before = projectHashes();
    const value = manager();
    const image = value.startImages(input(project), candidateDir, { ...IMAGE_AGENT, model: ' project-image-model ' });
    expect(await done(value, image.id)).toMatchObject({ model: 'project-image-model', permissions: 'workspace-write', status: 'completed' });
    const text = value.start(input(project));
    expect(await done(value, text.id)).toMatchObject({ model: 'text-codex-model', permissions: 'read-only', status: 'completed' });
    expect(invocations()).toHaveLength(2);
    expect(invocations()[0].args.slice(-3)).toEqual(['--model', 'project-image-model', '-']);
    expect(invocations()[1].args.slice(-3)).toEqual(['--model', 'text-codex-model', '-']);
    expect(settings.getAgent()).toEqual({ provider: 'codex', model: 'text-codex-model' });
    expect(projectHashes()).toEqual(before);
  });

  it('явная модель задания без проектных настроек (обложка) передаётся в --model', async () => {
    fakeCodex();
    settings.saveAgent({ provider: 'codex', model: 'text-codex-model' });
    const value = manager();
    const image = value.startImages(input(project), candidateDir, { ...IMAGE_AGENT, model: ' cover-model ' });
    expect(await done(value, image.id)).toMatchObject({ model: 'cover-model', permissions: 'workspace-write', status: 'completed' });
    expect(invocations()[0].args.slice(-3)).toEqual(['--model', 'cover-model', '-']);
  });

  it.each([undefined, '  '])('пустая модель опор %j оставляет выбор CLI без модели текстового агента', async (model) => {
    fakeCodex();
    settings.saveAgent({ provider: 'codex', model: 'text-codex-model' });
    const value = manager();
    const image = value.startImages(input(project), candidateDir, { ...IMAGE_AGENT, model });
    const completed = await done(value, image.id);
    expect(completed).toMatchObject({ provider: 'codex', status: 'completed' });
    expect(completed.model).toBeUndefined();
    expect(invocations()[0].args).not.toContain('--model');
  });

  it('модель опор не берётся из настроек проекта: её передаёт провайдер изображений', async () => {
    fakeCodex();
    imageProject({ provider: 'test', model: 'test-image-model' });
    const value = manager();
    const completed = await done(value, value.startImages(input(project), candidateDir, IMAGE_AGENT).id);
    expect(completed.model).toBeUndefined();
    expect(invocations()[0].args).not.toContain('--model');
  });

  it('изображения и обычные задания делят project busy и освобождают его после отмены', async () => {
    fakeCodex(true);
    settings.saveAgent({ provider: 'codex' });
    const value = manager();
    const image = value.startImages(input(project), candidateDir, IMAGE_AGENT);
    expect(() => value.start(input(project))).toThrow(/PROJECT_BUSY/);
    await vi.waitFor(() => expect(invocations()).toHaveLength(1));
    expect(value.cancel(image.id)).toMatchObject({ status: 'cancelled', permissions: 'workspace-write' });
    const generic = value.start(input(project));
    expect(() => value.startImages(input(project), candidateDir, IMAGE_AGENT)).toThrow(/PROJECT_BUSY/);
    await vi.waitFor(() => expect(invocations()).toHaveLength(2));
    expect(value.cancel(generic.id)).toMatchObject({ status: 'cancelled', permissions: 'read-only' });
    const next = value.startImages(input(project), candidateDir, IMAGE_AGENT);
    expect(next.status).toBe('running');
    value.cancel(next.id);
  });

  it('восстанавливает workspace-write историю после перезапуска без повторного процесса', async () => {
    fakeCodex();
    const value = manager();
    const job = value.startImages(input(project), candidateDir, IMAGE_AGENT);
    const completed = await done(value, job.id);
    const path = join(localDir, 'jobs', `agent-${job.id}.json`);
    writeFileSync(path, JSON.stringify({ ...completed, status: 'running', finishedAt: null }));
    const restored = manager();
    expect(restored.get(job.id)).toMatchObject({ status: 'interrupted', diagnostic: 'INTERRUPTED', permissions: 'workspace-write' });
    expect(invocations()).toHaveLength(1);
    expect(restored.list(project)).toHaveLength(1);
  });

  it('не принимает папку проекта и сам image-jobs вместо отдельной рабочей папки', () => {
    fakeCodex();
    const value = manager();
    expect(() => value.startImages(input(project), project, IMAGE_AGENT)).toThrow(/INVALID_INPUT/);
    expect(() => value.startImages(input(project), join(localDir, 'image-jobs'), IMAGE_AGENT)).toThrow(/INVALID_INPUT/);
    expect(value.list()).toEqual([]);
    expect(invocations()).toEqual([]);
  });

  it('собирает финальный JSON fake executable через KeyframeImages и сохраняет оригиналы', async () => {
    fakeCodex();
    const value = manager();
    const images = new KeyframeImages({ localDir, agents: value, validateImage: (path) => readFileSync(path).equals(Buffer.from(pngBase64, 'base64')) });
    const before = projectHashes();
    const requestSha = 'c'.repeat(64);
    const job = images.start(
      {
        project,
        shot: 'S01',
        packageDir: join(project, 'plan/batches/S01'),
        frames: [{ id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Кандидат первого кадра', referencePaths: [] }]
      },
      { provider: TEST_AGENT_PROVIDER, requestSha, agent: settings.getImageAgent(TEST_AGENT_PROVIDER) }
    );
    const completed = await done(value, job.id);
    const candidates = images.collect(completed, images.getRequestSha(completed));
    expect(candidates).toEqual([{ id: 'K01', path: join(invocations()[0].cwd, 'K01.png') }]);
    expect(projectHashes()).toEqual(before);
    expect(existsSync(join(project, 'K01.png'))).toBe(false);
  });
});
