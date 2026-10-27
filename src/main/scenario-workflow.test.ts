/** Предложение и согласование проверяются без настоящего CLI и без производства медиа. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentJob, AgentStartInput } from '@shared/agents';
import type { ScenarioPublication } from '@shared/scenario-workflow';
import type { CastFile, ScenesFile, TreatmentFile } from '@shared/types';
import { ScenarioWorkflow } from './scenario-workflow';
import { normalizeTreatment, viewScenario } from './scenario';
import { normalizeCast } from './cast';

let work: string;
let project: string;
let cast: CastFile;
let treatment: TreatmentFile;
let scenes: ScenesFile;
const sha = (value: string): string => createHash('sha256').update(value).digest('hex');
const write = (path: string, value: unknown): void => {
  mkdirSync(join(path, '..'), { recursive: true });
  writeFileSync(path, JSON.stringify(value, null, 2));
};

class FakeManager {
  jobs: AgentJob[] = [];
  inputs: AgentStartInput[] = [];
  start(value: unknown): AgentJob {
    const input = value as AgentStartInput;
    this.inputs.push(input);
    const job: AgentJob = {
      schemaVersion: 1,
      id: `job-${this.jobs.length}`,
      sequence: 1,
      project: input.project,
      provider: 'codex',
      task: input.task,
      permissions: 'read-only',
      inputHashes: { prompt: sha(input.prompt), context: sha(input.context ?? '') },
      status: 'running',
      phase: 'работает',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      result: '',
      log: ''
    };
    this.jobs.push(job);
    return structuredClone(job);
  }
  list(path?: string): AgentJob[] {
    return structuredClone(this.jobs.filter((job) => !path || job.project === path));
  }
  get(id: string): AgentJob | null {
    return structuredClone(this.jobs.find((job) => job.id === id) ?? null);
  }
  finish(result: unknown): void {
    Object.assign(this.jobs.at(-1)!, { status: 'completed', exitCode: 0, result: typeof result === 'string' ? result : JSON.stringify(result) });
  }
}
function setup(publishOverride?: (input: ScenarioPublication) => Promise<void>) {
  const agents = new FakeManager();
  const publish = vi.fn(
    publishOverride ??
      (async (input: ScenarioPublication) => {
        for (const key of input.pass === 'treatment' ? (['cast', 'treatment'] as const) : (['scenes'] as const))
          write(join(project, `plan/${key}.json`), input.after[key]);
      })
  );
  const scaffold = vi.fn(async () => structuredClone(scenes));
  const options = { localDir: join(work, 'state'), agents, toolsRoot: () => resolve(__dirname, '../..'), scaffold, publish };
  return { agents, publish, scaffold, workflow: new ScenarioWorkflow(options), options };
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-scenario-workflow-'));
  project = join(work, 'project');
  mkdirSync(join(project, 'source/heroes'), { recursive: true });
  writeFileSync(join(project, 'source/track.mp3'), 'трек');
  writeFileSync(join(project, 'source/text.md'), 'Строка песни');
  writeFileSync(join(project, 'source/description.md'), 'Драматическая поездка');
  writeFileSync(join(project, 'source/heroes/hero.png'), 'образ');
  const file = (path: string, value: string) => ({ path, sha256: sha(value), bytes: Buffer.byteLength(value) });
  write(join(project, 'source/manifest.json'), {
    schema_version: 1,
    track: { ...file('track.mp3', 'трек'), original_name: 'track.mp3', duration_seconds: 10.3 },
    lyrics: { ...file('text.md', 'Строка песни'), lines: 1, sections: [] },
    idea: file('description.md', 'Драматическая поездка'),
    cover: null,
    references: [
      { id: 'hero', kind: 'hero', name: 'Герой', short_name: 'Герой', description: 'Человек в куртке', files: [file('heroes/hero.png', 'образ')], prompt: null }
    ],
    updated_at: ''
  });
  write(join(project, 'plan/project.json'), { schema_version: 1, name: 'Проба' });
  write(join(project, 'plan/production-status.json'), {});
  write(join(project, 'plan/audio/timing.json'), {
    version: 2,
    status: 'Подтверждена',
    source: 'manual',
    sha256: sha('трек'),
    duration_decoded: 10,
    duration_container: 10.3,
    clock: 'seconds',
    lines: [{ id: 1, source_line: 1, start: 0, end: 1, verified: true }],
    sections: [{ name: 'Куплет', start: 0, end: 10 }]
  });
  cast = {
    schema_version: 1,
    entities: [
      {
        id: 'hero',
        kind: 'hero',
        name: 'Герой',
        short_name: 'Герой',
        role: 'Водитель',
        appearance: 'Куртка',
        images: ['heroes/hero.png'],
        initial_state: { position: 'у двери' }
      }
    ],
    properties: { hero: [{ key: 'position', label: 'Положение', hint: '' }] }
  };
  treatment = {
    schema_version: 1,
    logline: 'Герой возвращается',
    sequences: [{ id: 'verse', title: 'Куплет', direction: 'Путь домой', start: 0, end: 10, entities: ['hero'], lipsync: false }]
  };
  scenes = {
    schema_version: 1,
    fps: 30,
    audio: { path: 'source/track.mp3', end_seconds: '10.000' },
    references: { hero: { name: 'Герой', path: 'source/heroes/hero.png' } },
    visual_direction: 'Холодная палитра',
    sequences: [{ id: 'verse', title: 'Куплет', direction: 'Путь домой' }],
    scenes: ['M01', 'M02'].map((id, index) => ({
      id,
      original: index ? 'Инструментал' : 'Строка песни',
      sequence: 'verse',
      start_frame: index * 150,
      end_frame_exclusive: (index + 1) * 150,
      camera: 'Общий план',
      action: 'Герой идёт',
      continuity: 'Та же куртка',
      references: ['hero'],
      lipsync: false,
      card: { primary_reference: 'hero' },
      state_from: index ? 'M01' : null,
      state_changes: {}
    }))
  };
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

function currentPair(): void {
  write(join(project, 'plan/cast.json'), cast);
  write(join(project, 'plan/treatment.json'), treatment);
}

describe('ScenarioWorkflow', () => {
  it.each([
    { schemaVersion: 1, pending: {} },
    { schemaVersion: 1, approval: true },
    { schemaVersion: 1, scenesApproval: { hashes: [] } },
    { schemaVersion: 1, needsScenesReview: 'да' }
  ])('повреждённые локальные метаданные не блокируют проект и не служат approval: %j', (state) => {
    currentPair();
    const { workflow } = setup();
    write(join(work, 'state/scenario-workflow', `${sha(project)}.json`), state);
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: false, proposal: null, canStartTreatment: true, canApproveCurrent: true });
    expect(workflow.approveCurrent(project).treatmentApproved).toBe(true);
  });

  it('обложка остаётся оформлением и не попадает в контекст агента или изображения кастинга', async () => {
    const cover = 'ДЕКОРАТИВНАЯ ОБЛОЖКА';
    writeFileSync(join(project, 'source/project-decoration.png'), cover);
    const manifestPath = join(project, 'source/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.cover = { path: 'project-decoration.png', sha256: sha(cover), bytes: Buffer.byteLength(cover) };
    manifest.updated_at = '2026-01-01T00:00:00.000Z';
    write(manifestPath, manifest);
    const { workflow, agents } = setup();
    await workflow.start({ project, pass: 'treatment' });
    const context = JSON.parse(agents.inputs[0].context!);
    expect(context.manifest).not.toHaveProperty('cover');
    expect(context.manifest).not.toHaveProperty('updated_at');
    expect(agents.inputs[0].context).not.toContain('project-decoration.png');
    expect(context.manifest.references).toEqual(manifest.references);
    expect(context.cast.entities.flatMap((entity: { images: string[] }) => entity.images)).toEqual(['heroes/hero.png']);
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).cover).toEqual(manifest.cover);
    expect(readFileSync(join(project, 'source/project-decoration.png'), 'utf8')).toBe(cover);
  });

  it('первый проход не требует реестра, не пишет preview в проект и утверждает только после Apply', async () => {
    const { workflow, agents, publish } = setup();
    expect(workflow.view(project)).toMatchObject({ canStartTreatment: true, canStartScenes: false, treatmentApproved: false });
    const started = await workflow.start({ project, pass: 'treatment' });
    expect(started.proposal?.status).toBe('running');
    expect(agents.inputs[0]).toMatchObject({ task: 'ai-clip-scenario:treatment' });
    expect(JSON.parse(agents.inputs[0].context!).cast.entities.some((e: { id: string }) => e.id === 'hero')).toBe(true);
    expect(agents.inputs[0].prompt).toContain('output=proposal');
    agents.finish({ schemaVersion: 1, pass: 'treatment', cast, treatment });
    const ready = workflow.view(project);
    expect(ready.proposal?.status).toBe('ready');
    expect(publish).not.toHaveBeenCalled();
    expect(workflow.view(project).canStartScenes).toBe(false);
    await workflow.apply(project, ready.proposal!.id);
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: true, canStartScenes: true });
    expect(publish.mock.calls[0][0].expectedHashes).toMatchObject({
      'plan/cast.json': null,
      'plan/treatment.json': null,
      'plan/project.json': expect.any(String),
      'source/heroes/hero.png': sha('образ')
    });
  });

  it('явно утверждает старую ручную пару и использует decoded duration', async () => {
    currentPair();
    write(join(project, 'plan/scenes.json'), scenes);
    const { workflow, agents } = setup();
    expect(viewScenario(project, null).duration).toBe(10);
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: false, scenesNeedReview: false, canApproveCurrent: true });
    workflow.approveCurrent(project);
    expect(workflow.view(project)).toMatchObject({ canStartScenes: true, scenesNeedReview: false });
    await workflow.start({ project, pass: 'scenes' });
    agents.finish({ schemaVersion: 1, pass: 'scenes', scenes });
    expect(workflow.view(project).proposal?.status).toBe('ready');
  });

  it('не считает наличие пары утверждением и блокирует проход без проверки timing', async () => {
    currentPair();
    const { workflow } = setup();
    await expect(workflow.start({ project, pass: 'scenes' })).rejects.toThrow('утвердите');
    const timingPath = join(project, 'plan/audio/timing.json');
    const timing = JSON.parse(readFileSync(timingPath, 'utf8'));
    timing.lines[0].verified = false;
    write(timingPath, timing);
    expect(workflow.view(project)).toMatchObject({ canStartTreatment: false, canApproveCurrent: false });
    expect(workflow.view(project).problems.join(' ')).toContain('на слух');
  });

  it.each([false, true])('изменение производных делает proposal stale, не снимая upstream approval; прежний файл=%s', async (existing) => {
    currentPair();
    if (existing) writeFileSync(join(project, 'ROADMAP.md'), 'Прежняя версия');
    const { workflow, agents, publish } = setup();
    workflow.approveCurrent(project);
    await workflow.start({ project, pass: 'scenes' });
    agents.finish({ schemaVersion: 1, pass: 'scenes', scenes });
    const ready = workflow.view(project);
    expect(ready.proposal?.status).toBe('ready');
    writeFileSync(join(project, 'ROADMAP.md'), 'Ручная правка');
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: true, proposal: { stale: true } });
    await expect(workflow.apply(project, ready.proposal!.id)).rejects.toThrow();
    expect(publish).not.toHaveBeenCalled();
  });

  it.each([false, true])('обложка и её удаление сохраняют утверждения и готовое предложение; удаление=%s', async (remove) => {
    currentPair();
    write(join(project, 'plan/scenes.json'), scenes);
    const { workflow, agents } = setup();
    workflow.approveCurrent(project);
    const statePath = join(work, 'state/scenario-workflow', `${sha(project)}.json`);
    const approved = JSON.parse(readFileSync(statePath, 'utf8'));
    approved.scenesApproval = { hashes: approved.approval, sceneHash: sha(readFileSync(join(project, 'plan/scenes.json'), 'utf8')) };
    approved.needsScenesReview = false;
    write(statePath, approved);
    await workflow.start({ project, pass: 'revise', selectedIds: ['M01'], note: 'Уточнить действие' });
    agents.finish({ schemaVersion: 1, pass: 'revise', patches: [{ id: 'M01', action: 'Герой смотрит вперёд' }] });
    expect(workflow.view(project).proposal).toMatchObject({ status: 'ready', stale: false });
    const manifestPath = join(project, 'source/manifest.json');
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    manifest.cover = remove ? null : { path: 'cover.jpg', sha256: 'a'.repeat(64), bytes: 10 };
    manifest.updated_at = 'новая дата';
    write(manifestPath, manifest);
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: true, scenesNeedReview: false, proposal: { status: 'ready', stale: false } });
    await workflow.apply(project, workflow.view(project).proposal!.id);
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: true, scenesNeedReview: false });
  });

  it('первая смена обложки сохраняет доказанные утверждения старой версии', () => {
    currentPair();
    write(join(project, 'plan/scenes.json'), scenes);
    const { workflow } = setup();
    workflow.approveCurrent(project);
    const statePath = join(work, 'state/scenario-workflow', `${sha(project)}.json`);
    const state = JSON.parse(readFileSync(statePath, 'utf8'));
    const oldRaw = sha(readFileSync(join(project, 'source/manifest.json'), 'utf8'));
    state.approval['source/manifest.json'] = oldRaw;
    state.scenesApproval = { hashes: structuredClone(state.approval), sceneHash: sha(readFileSync(join(project, 'plan/scenes.json'), 'utf8')) };
    state.needsScenesReview = false;
    write(statePath, state);
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: true, scenesNeedReview: false });
    workflow.preserveSourceDecoration(project);
    expect(JSON.parse(readFileSync(statePath, 'utf8')).approval['source/manifest.json']).not.toBe(oldRaw);
    const manifest = JSON.parse(readFileSync(join(project, 'source/manifest.json'), 'utf8'));
    manifest.cover = { path: 'new-cover.png', sha256: 'b'.repeat(64) };
    manifest.updated_at = 'после смены';
    write(join(project, 'source/manifest.json'), manifest);
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: true, scenesNeedReview: false });
  });

  it.each(['plan/audio/timing.json', 'source/manifest.json', 'source/description.md', 'source/text.md', 'source/heroes/hero.png'])(
    'изменение %s инвалидирует утверждение и предложение',
    async (path) => {
      currentPair();
      const { workflow, agents, publish } = setup();
      workflow.approveCurrent(project);
      await workflow.start({ project, pass: 'treatment' });
      agents.finish({ schemaVersion: 1, pass: 'treatment', cast, treatment });
      const ready = workflow.view(project);
      if (path === 'source/manifest.json') {
        const manifest = JSON.parse(readFileSync(join(project, path), 'utf8'));
        manifest.references[0].description = 'Новый образ героя';
        write(join(project, path), manifest);
      } else writeFileSync(join(project, path), readFileSync(join(project, path), 'utf8') + ' ');
      expect(workflow.view(project)).toMatchObject({ treatmentApproved: false, canStartScenes: false, proposal: { stale: true } });
      await expect(workflow.apply(project, ready.proposal!.id)).rejects.toThrow('актуальное');
      expect(publish).not.toHaveBeenCalled();
    }
  );

  it.each([
    null,
    { schemaVersion: 1, pass: 'treatment', cast: { ...{}, schema_version: 1, entities: [null], properties: {} }, treatment: {} },
    '```json\n{}\n```',
    { schemaVersion: 1, pass: 'treatment', cast: {}, treatment: {} }
  ])('показывает невалидный ответ без изменения файлов: %j', async (result) => {
    currentPair();
    const before = readFileSync(join(project, 'plan/cast.json'), 'utf8');
    const { workflow, agents, publish } = setup();
    await workflow.start({ project, pass: 'treatment' });
    agents.finish(result);
    const view = workflow.view(project);
    expect(view.proposal?.status).toBe('invalid');
    await expect(workflow.apply(project, view.proposal!.id)).rejects.toThrow();
    expect(readFileSync(join(project, 'plan/cast.json'), 'utf8')).toBe(before);
    expect(publish).not.toHaveBeenCalled();
  });

  it('повторное ручное утверждение изменённой пары сохраняет необходимость пересмотра сценария', () => {
    currentPair();
    write(join(project, 'plan/scenes.json'), scenes);
    const { workflow } = setup();
    workflow.approveCurrent(project);
    write(join(project, 'plan/treatment.json'), { ...treatment, logline: 'Другая история' });
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: false, scenesNeedReview: true });
    workflow.approveCurrent(project);
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: true, scenesNeedReview: true });
  });

  it('принимает валидный proposal с другим порядком ключей JSON-объектов', async () => {
    currentPair();
    const { workflow, agents, publish } = setup();
    workflow.approveCurrent(project);
    await workflow.start({ project, pass: 'scenes' });
    const reordered = structuredClone(scenes);
    reordered.audio = { end_seconds: scenes.audio.end_seconds, path: scenes.audio.path };
    reordered.sequences = scenes.sequences.map((part) => ({ direction: part.direction, title: part.title, id: part.id }));
    reordered.references.hero = { path: scenes.references.hero.path, name: scenes.references.hero.name };
    agents.finish({ schemaVersion: 1, pass: 'scenes', scenes: reordered });
    const ready = workflow.view(project);
    expect(ready.proposal?.status).toBe('ready');
    await workflow.apply(project, ready.proposal!.id);
    expect(publish).toHaveBeenCalledOnce();
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: true, scenesNeedReview: false });
  });

  it.each(['id', 'original', 'sequence', 'start_frame', 'end_frame_exclusive'] as const)('сохраняет каркас подробного сценария: %s', async (field) => {
    currentPair();
    const { workflow, agents } = setup();
    workflow.approveCurrent(project);
    await workflow.start({ project, pass: 'scenes' });
    const changed = structuredClone(scenes);
    Object.assign(changed.scenes[0], { [field]: typeof changed.scenes[0][field] === 'number' ? 1 : 'изменено' });
    agents.finish({ schemaVersion: 1, pass: 'scenes', scenes: changed });
    expect(workflow.view(project).proposal).toMatchObject({ status: 'invalid', message: expect.stringContaining('нельзя менять') });
  });

  it('незаполненная постановка и неверные вложенные типы не становятся готовым сценарием', async () => {
    currentPair();
    const { workflow, agents } = setup();
    workflow.approveCurrent(project);
    await workflow.start({ project, pass: 'scenes' });
    const changed = structuredClone(scenes);
    changed.scenes[0].camera = 'ЗАПОЛНИТЬ';
    agents.finish({ schemaVersion: 1, pass: 'scenes', scenes: changed });
    expect(workflow.view(project).proposal).toMatchObject({ status: 'invalid', message: expect.stringContaining('незаполненная') });
    await workflow.start({ project, pass: 'scenes' });
    agents.finish({ schemaVersion: 1, pass: 'scenes', scenes: { ...scenes, scenes: [null] } });
    expect(workflow.view(project).proposal).toMatchObject({ status: 'invalid', message: expect.stringContaining('структура плана') });
  });

  it('не создаёт второй job во время подготовки каркаса и замечает изменения до запуска', async () => {
    currentPair();
    const { workflow, agents, scaffold } = setup();
    workflow.approveCurrent(project);
    let finish: (scenes: ScenesFile) => void = () => undefined;
    scaffold.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        })
    );
    const started = workflow.start({ project, pass: 'scenes' });
    expect(workflow.view(project).busy).toBe(true);
    await expect(workflow.start({ project, pass: 'treatment' })).rejects.toThrow();
    write(join(project, 'plan/production-status.json'), { changed: true });
    finish(scenes);
    await expect(started).rejects.toThrow('изменились при подготовке');
    expect(agents.jobs).toHaveLength(0);
  });

  it('дорабатывает только выбранный план и показывает влияние наследуемого состояния', async () => {
    currentPair();
    write(join(project, 'plan/scenes.json'), scenes);
    const { workflow, agents, publish } = setup();
    workflow.approveCurrent(project);
    await workflow.start({ project, pass: 'revise', selectedIds: ['M01'], note: 'Пусть войдёт' });
    agents.finish({
      schemaVersion: 1,
      pass: 'revise',
      patches: [{ id: 'M01', action: 'Герой входит', state_changes: { after: { hero: { position: 'внутри' } } } }]
    });
    const ready = workflow.view(project);
    expect(ready.proposal).toMatchObject({ status: 'ready', changedIds: ['M01', 'M02'] });
    expect(ready.proposal!.after.scenes!.scenes[1]).toEqual(scenes.scenes[1]);
    await workflow.apply(project, ready.proposal!.id);
    expect(publish.mock.calls[0][0].after.scenes?.scenes[0].action).toBe('Герой входит');
    expect(workflow.view(project).scenesNeedReview).toBe(false);
  });

  it.each([
    { id: 'M02', action: 'Изменено' },
    { id: 'M01', start_frame: 3 },
    { id: 'M01', original: 'Другая песня' },
    { id: 'M01', visual_direction: 'Красное' },
    { id: 'M01', state_changes: { after: { hero: { invented: 'нет' } } } }
  ])('отклоняет выход за границы доработки: %j', async (patch) => {
    currentPair();
    write(join(project, 'plan/scenes.json'), scenes);
    const { workflow, agents } = setup();
    workflow.approveCurrent(project);
    await workflow.start({ project, pass: 'revise', selectedIds: ['M01'], note: 'Поправить' });
    agents.finish({ schemaVersion: 1, pass: 'revise', patches: [patch] });
    expect(workflow.view(project).proposal?.status).toBe('invalid');
  });

  it('проверяет весь результат: цикл соседней сцены не проходит', async () => {
    currentPair();
    write(join(project, 'plan/scenes.json'), scenes);
    const { workflow, agents } = setup();
    workflow.approveCurrent(project);
    await workflow.start({ project, pass: 'revise', selectedIds: ['M01'], note: 'Повтор' });
    agents.finish({ schemaVersion: 1, pass: 'revise', patches: [{ id: 'M01', state_from: 'M02' }] });
    expect(workflow.view(project).proposal).toMatchObject({ status: 'invalid', message: expect.stringContaining('Цикл') });
  });

  it.each(['cancelled', 'failed', 'interrupted'] as const)('не применяет %s и сохраняет результат после перезапуска', async (status) => {
    const { workflow, agents, options, publish } = setup();
    await workflow.start({ project, pass: 'treatment' });
    agents.jobs[0].status = status;
    const restored = new ScenarioWorkflow(options);
    const view = restored.view(project);
    expect(view.proposal?.status).toBe(status === 'interrupted' ? 'interrupted' : 'failed');
    await expect(restored.apply(project, view.proposal!.id)).rejects.toThrow();
    restored.discard(project, view.proposal!.id);
    expect(restored.view(project).proposal).toBeNull();
    expect(publish).not.toHaveBeenCalled();
  });

  it('ошибка публикации не создаёт approval и оставляет предложение для повторного применения', async () => {
    const { workflow, agents } = setup(async () => {
      throw new Error('Ошибка диска');
    });
    await workflow.start({ project, pass: 'treatment' });
    agents.finish({ schemaVersion: 1, pass: 'treatment', cast, treatment });
    const ready = workflow.view(project);
    await expect(workflow.apply(project, ready.proposal!.id)).rejects.toThrow('Ошибка диска');
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: false, proposal: { status: 'ready' } });
  });

  it('явно утверждает полный ручной сценарий после смены трактовки без нового CLI', async () => {
    currentPair();
    write(join(project, 'plan/scenes.json'), scenes);
    const { workflow, agents } = setup();
    workflow.approveCurrent(project);
    await workflow.start({ project, pass: 'treatment' });
    agents.finish({ schemaVersion: 1, pass: 'treatment', cast, treatment: { ...treatment, logline: 'Новая трактовка' } });
    await workflow.apply(project, workflow.view(project).proposal!.id);
    expect(workflow.view(project)).toMatchObject({ scenesNeedReview: true, canApproveScenes: true });
    scenes.scenes[0].action = 'Ручная адаптация к новой трактовке';
    write(join(project, 'plan/scenes.json'), scenes);
    const bytes = readFileSync(join(project, 'plan/scenes.json'), 'utf8');
    expect(workflow.approveScenes(project)).toMatchObject({ treatmentApproved: true, scenesNeedReview: false, canApproveScenes: false });
    expect(readFileSync(join(project, 'plan/scenes.json'), 'utf8')).toBe(bytes);
    expect(agents.jobs).toHaveLength(1);
  });

  it.each(['placeholder', 'reference', 'state'] as const)('ручное утверждение сценария проверяет готовность: %s', (issue) => {
    currentPair();
    write(join(project, 'plan/scenes.json'), scenes);
    const { workflow, agents } = setup();
    workflow.approveCurrent(project);
    write(join(project, 'plan/treatment.json'), { ...treatment, logline: 'Новая трактовка' });
    workflow.approveCurrent(project);
    if (issue === 'placeholder') scenes.scenes[0].camera = 'ЗАПОЛНИТЬ';
    else if (issue === 'reference') scenes.scenes[0].references = ['missing'];
    else scenes.scenes[0].state_changes = { after: { hero: { unknown: 'положение' } } };
    write(join(project, 'plan/scenes.json'), scenes);
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: true, scenesNeedReview: true, canApproveScenes: false });
    expect(() => workflow.approveScenes(project)).toThrow();
    expect(agents.jobs).toHaveLength(0);
  });

  it('ручное сохранение сцен при неизменной утверждённой паре не требует CLI и не устаревает upstream', async () => {
    currentPair();
    write(join(project, 'plan/scenes.json'), scenes);
    const { workflow, agents } = setup();
    workflow.approveCurrent(project);
    scenes.scenes[0].action = 'Ручная постановка';
    write(join(project, 'plan/scenes.json'), scenes);
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: true, scenesNeedReview: false });
    await workflow.start({ project, pass: 'scenes' });
    agents.finish({ schemaVersion: 1, pass: 'scenes', scenes });
    await workflow.apply(project, workflow.view(project).proposal!.id);
    scenes.scenes[0].action = 'Ручная постановка после предложения';
    write(join(project, 'plan/scenes.json'), scenes);
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: true, scenesNeedReview: false });
  });

  it('смена трактовки требует пересмотра прежнего сценария и сохраняет новую связь после scenes Apply', async () => {
    currentPair();
    write(join(project, 'plan/scenes.json'), scenes);
    const { workflow, agents } = setup();
    workflow.approveCurrent(project);
    await workflow.start({ project, pass: 'treatment' });
    agents.finish({ schemaVersion: 1, pass: 'treatment', cast, treatment: { ...treatment, logline: 'Новая трактовка' } });
    await workflow.apply(project, workflow.view(project).proposal!.id);
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: true, scenesNeedReview: true });
    await workflow.start({ project, pass: 'scenes' });
    agents.finish({ schemaVersion: 1, pass: 'scenes', scenes });
    await workflow.apply(project, workflow.view(project).proposal!.id);
    expect(workflow.view(project).scenesNeedReview).toBe(false);
    treatment.logline = 'Внешняя правка';
    write(join(project, 'plan/treatment.json'), treatment);
    expect(workflow.view(project)).toMatchObject({ treatmentApproved: false, scenesNeedReview: true });
  });
});

describe('чистая нормализация', () => {
  it('отклоняет недоверенные вложенные типы до trim/map', () => {
    expect(() => normalizeCast({ ...cast, entities: [{ ...cast.entities[0], name: [] }] }, null)).toThrow('структура');
    expect(() => normalizeTreatment({ ...treatment, sequences: [null] }, 10)).toThrow('структура');
    expect(() => normalizeTreatment({ ...treatment, sequences: [{ ...treatment.sequences[0], start: '0' }] }, 10)).toThrow('структура');
  });
});
