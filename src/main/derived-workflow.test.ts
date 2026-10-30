/** Контекст, снимки и запуск локального задания проверяются без выбранного агента и без процессов генерации. */
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobInfo, ScenesFile } from '@shared/types';
import type { DerivedShotRecipe } from '@shared/derived-shot';
import { DerivedWorkflow } from './derived-workflow';
import { writeAcceptedFingerprints, projectFingerprints } from './shot-acceptance';
import type { Jobs } from './jobs';

const REPO = resolve(__dirname, '../..');
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
let project: string;
let registry: ScenesFile;
let jobs: {
  list: () => JobInfo[];
  get: (id: string) => JobInfo | null;
  start: ReturnType<typeof vi.fn>;
  launcher: { runtime: ReturnType<typeof vi.fn>; options: { toolsRoot: string } };
};
let stored: JobInfo[];
let workflow: DerivedWorkflow;
const recipe: DerivedShotRecipe = { mode: 'fit', start_frame: 0, end_frame_exclusive: 60 };
const json = (path: string, value: unknown): void => {
  mkdirSync(join(project, path, '..'), { recursive: true });
  writeFileSync(join(project, path), JSON.stringify(value));
};

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-derived-service-'));
  cpSync(join(REPO, 'tools/testdata/sample-project'), project, { recursive: true });
  registry = JSON.parse(readFileSync(join(project, 'plan/scenes.json'), 'utf8')) as ScenesFile;
  registry.scenes[0].derived_from = { shot: 'M02' };
  registry.scenes[0].lipsync = false;
  json('plan/scenes.json', registry);
  json('plan/project.json', { schema_version: 1, name: 'Без агента', animatic_video: 'check.mp4', generation: { image: null, video: null } });
  writeAcceptedFingerprints(project, projectFingerprints(project, registry));
  stored = [];
  jobs = {
    launcher: { runtime: vi.fn(() => ({})), options: { toolsRoot: REPO } },
    list: () => stored,
    get: (id) => stored.find((job) => job.id === id) ?? null,
    start: vi.fn((kind, title, selectedProject, steps) => {
      const job: JobInfo = {
        id: `job-${stored.length}`,
        kind,
        title,
        project: selectedProject,
        status: 'running',
        startedAt: '',
        finishedAt: null,
        log: '',
        code: null,
        steps: steps.map((step: { tool: string; label: string }) => ({ tool: step.tool, label: step.label, status: 'running', code: null }))
      };
      stored.push(job);
      return job;
    })
  };
  workflow = new DerivedWorkflow(jobs as unknown as Jobs);
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

function ready() {
  const view = workflow.build(project, 'M01', recipe);
  const call = jobs.start.mock.calls[0];
  const args: string[] = call[3][0].args;
  const directory = args[args.indexOf('--work-dir') + 1];
  const source = JSON.parse(readFileSync(join(project, 'assets/shots/M02/manifest.json'), 'utf8'));
  const fingerprints = projectFingerprints(project, registry);
  json(`${directory}/preview.json`, {
    schema_version: 1,
    shot: 'M01',
    source_shot: 'M02',
    source_scene_sha256: fingerprints.M02,
    source_accepted_video_sha256: source.accepted_edit.video.sha256,
    target_scene_sha256: fingerprints.M01,
    target_frames: view.targetFrames,
    recipe,
    result_token: 'a'.repeat(64),
    video: { path: 'candidate.mp4', sha256: hash('candidate') },
    preview: { path: 'preview.mp4', sha256: hash('preview') },
    audio_source: {
      path: registry.audio.path,
      sha256: existsSync(join(project, registry.audio.path)) ? hash(readFileSync(join(project, registry.audio.path))) : null
    }
  });
  json(`${directory}/build.json`, { source_manifest_sha256: hash(readFileSync(join(project, 'assets/shots/M02/manifest.json'))) });
  writeFileSync(join(project, directory, 'candidate.mp4'), 'candidate');
  writeFileSync(join(project, directory, 'preview.mp4'), 'preview');
  stored[0].status = 'done';
  return workflow.view(project, 'M01');
}

function acceptedFixture() {
  const view = ready();
  const manifest = {
    schema_version: 1,
    shot: 'M01',
    kind: 'derived_video',
    generation: {
      source_shot: 'M02',
      source_scene_sha256: projectFingerprints(project, registry).M02,
      source_accepted_video_sha256: JSON.parse(readFileSync(join(project, 'assets/shots/M02/manifest.json'), 'utf8')).accepted_edit.video.sha256
    },
    accepted_edit: { video: { path: 'derived-output/video.mp4', sha256: hash('candidate') } }
  };
  json('assets/shots/M01/manifest.json', manifest);
  mkdirSync(join(project, 'assets/shots/M01/derived-output'), { recursive: true });
  cpSync(view.preview!.candidatePath, join(project, 'assets/shots/M01/derived-output/video.mp4'));
  const id = 'b'.repeat(32);
  json(`plan/derived-history/${id}/journal.json`, {
    schema_version: 1,
    id,
    shot: 'M01',
    state: 'committed',
    result_token: view.preview!.resultToken,
    directory: { path: 'assets/shots/M01', after_files: { 'manifest.json': hash(readFileSync(join(project, 'assets/shots/M01/manifest.json'))) } }
  });
  json('plan/derived/M01/latest.json', { id: view.preview!.id, jobId: 'удалённое-задание', operation: 'accept' });
  stored = [];
  return workflow.view(project, 'M01');
}

describe('локальный процесс производного плана', () => {
  it('открывает контекст без записи и без Python; настройки сохраняются при недоступном runtime', () => {
    jobs.launcher.runtime.mockImplementation(() => {
      throw new Error('Нет Python');
    });
    const view = workflow.view(project, 'M01');
    expect(view.sourceShot).toBe('M02');
    expect(view.sourceTitle).toBe('Фонарики');
    expect(view.problem).toBeNull();
    expect(view.toolsProblem).toContain('Python');
    expect(existsSync(join(project, 'plan/derived'))).toBe(false);
    expect(workflow.save(project, 'M01', recipe).recipe).toEqual(recipe);
    expect(jobs.start).not.toHaveBeenCalled();
  });

  it('запускает только derive_shot, сохраняет точный рецепт отдельно от неизменной папки результата и блокирует двойной клик', () => {
    const view = workflow.build(project, 'M01', recipe);
    expect(view.job?.status).toBe('running');
    const call = jobs.start.mock.calls[0];
    expect(call.slice(0, 3)).toEqual(['tool', 'Сборка производного плана M01', project]);
    const step = call[3][0];
    expect(step.tool).toBe('derive_shot');
    expect(step.args[0]).toBe('build');
    const recipePath = step.args[step.args.indexOf('--recipe') + 1];
    const work = step.args[step.args.indexOf('--work-dir') + 1];
    expect(JSON.parse(readFileSync(join(project, recipePath), 'utf8'))).toEqual(recipe);
    expect(existsSync(join(project, work))).toBe(false);
    expect(() => workflow.build(project, 'M01', recipe)).toThrow('Дождитесь');
    expect(jobs.start).toHaveBeenCalledTimes(1);
  });

  it('отдельно принимает показанный результат и требует явную замену принятого комплекта', () => {
    const view = ready();
    expect(view.preview?.fresh).toBe(true);
    expect(() => workflow.accept(project, 'M01', view.preview!.id, view.preview!.resultToken, false)).toThrow('замену');
    const accepting = workflow.accept(project, 'M01', view.preview!.id, view.preview!.resultToken, true);
    expect(accepting.job?.status).toBe('running');
    expect(jobs.start.mock.calls[1][3][0].args).toContain('--replace');
    expect(jobs.start.mock.calls[1][3][0].args[0]).toBe('accept');
  });

  it('после смены настроек, постановки или источника запрещает приёмку старого результата', () => {
    const view = ready();
    workflow.save(project, 'M01', { mode: 'still', frame: 0 });
    expect(workflow.view(project, 'M01').preview?.fresh).toBe(false);
    expect(() => workflow.accept(project, 'M01', view.preview!.id, view.preview!.resultToken, true)).toThrow('изменились');
    workflow.save(project, 'M01', recipe);
    registry.scenes[0].action += ' Изменение';
    json('plan/scenes.json', registry);
    expect(workflow.view(project, 'M01').preview?.fresh).toBe(false);
    registry.scenes[0].action = registry.scenes[0].action.replace(' Изменение', '');
    json('plan/scenes.json', registry);
    const manifest = JSON.parse(readFileSync(join(project, 'assets/shots/M02/manifest.json'), 'utf8'));
    writeFileSync(join(project, 'assets/shots/M02', manifest.accepted_edit.video.path), 'Новые байты');
    expect(workflow.view(project, 'M01').problem).toContain('нет доступного');
    expect(jobs.start).toHaveBeenCalledTimes(1);
  });

  it('подменённый кандидат и токен не запускают приёмку, данные другого проекта не подмешиваются', () => {
    const view = ready();
    expect(() => workflow.accept(project, 'M01', view.preview!.id, 'b'.repeat(64), true)).toThrow();
    writeFileSync(view.preview!.candidatePath, 'Подмена');
    expect(workflow.view(project, 'M01').preview).toBeNull();
    expect(() => workflow.accept(project, 'M01', view.preview!.id, view.preview!.resultToken, true)).toThrow();
    expect(jobs.start).toHaveBeenCalledTimes(1);
  });

  it('после правки только происхождения источника отмечает пробу устаревшей до запуска приёмки', () => {
    const view = ready();
    const path = join(project, 'assets/shots/M02/manifest.json');
    const manifest = JSON.parse(readFileSync(path, 'utf8'));
    const video = join(project, 'assets/shots/M02', manifest.accepted_edit.video.path);
    const beforeBytes = readFileSync(video);
    const beforeStat = statSync(video, { bigint: true });
    manifest.generation.inputs[0].role += ' (уточнённая подпись)';
    json('assets/shots/M02/manifest.json', manifest);
    const changed = workflow.view(project, 'M01');
    expect(changed.problem).toBeNull();
    expect(changed.preview?.fresh).toBe(false);
    expect(readFileSync(video)).toEqual(beforeBytes);
    expect(statSync(video, { bigint: true })).toEqual(beforeStat);
    expect(() => workflow.accept(project, 'M01', view.preview!.id, view.preview!.resultToken, true)).toThrow('изменились');
    expect(jobs.start).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'invalid'])('не разрешает приёмку без корректного снимка манифеста: %s', (kind) => {
    const view = ready();
    const path = join(project, 'plan/derived/M01', view.preview!.id, 'build.json');
    if (kind === 'missing') rmSync(path);
    else writeFileSync(path, JSON.stringify({ source_manifest_sha256: 'не SHA-256' }));
    expect(workflow.view(project, 'M01').preview?.fresh).toBe(false);
    expect(() => workflow.accept(project, 'M01', view.preview!.id, view.preview!.resultToken, true)).toThrow('изменились');
    expect(jobs.start).toHaveBeenCalledTimes(1);
  });

  it.each(['replace', 'remove', 'appear', 'path'])('после изменения трека запрещает приёмку до запуска задания: %s', (kind) => {
    const path = join(project, registry.audio.path);
    if (kind === 'appear') rmSync(path);
    const view = ready();
    expect(view.preview?.fresh).toBe(true);
    if (kind === 'remove') rmSync(path);
    else if (kind === 'path') {
      registry.audio.path = 'source/replacement.mp3';
      cpSync(path, join(project, registry.audio.path));
      json('plan/scenes.json', registry);
    } else writeFileSync(path, 'Новая версия трека');
    const changed = workflow.view(project, 'M01');
    expect(changed.problem).toBeNull();
    expect(changed.preview?.fresh).toBe(false);
    expect(() => workflow.accept(project, 'M01', view.preview!.id, view.preview!.resultToken, true)).toThrow('изменились');
    expect(jobs.start).toHaveBeenCalledTimes(1);
  });

  it.each(['missing', 'invalid'])('не разрешает приёмку без корректного снимка трека: %s', (kind) => {
    const view = ready();
    const path = `plan/derived/M01/${view.preview!.id}/preview.json`;
    const receipt = JSON.parse(readFileSync(join(project, path), 'utf8'));
    if (kind === 'missing') delete receipt.audio_source;
    else receipt.audio_source.sha256 = 'не SHA-256';
    json(path, receipt);
    expect(workflow.view(project, 'M01').preview?.fresh).toBe(false);
    expect(() => workflow.accept(project, 'M01', view.preview!.id, view.preview!.resultToken, true)).toThrow('изменились');
    expect(jobs.start).toHaveBeenCalledTimes(1);
  });

  it('сохраняет признак принятия по проектному журналу после удаления задания и переноса проекта', () => {
    const accepted = acceptedFixture();
    expect(accepted.job).toBeNull();
    expect(accepted.preview?.accepted).toBe(true);
    const moved = `${project}-moved`;
    try {
      cpSync(project, moved, { recursive: true });
      expect(workflow.view(moved, 'M01').preview?.accepted).toBe(true);
    } finally {
      rmSync(moved, { recursive: true, force: true });
    }
  });

  it.each(['manifest', 'video', 'missing'])('не считает старую пробу принятой после изменения выбранного комплекта: %s', (kind) => {
    expect(acceptedFixture().preview?.accepted).toBe(true);
    if (kind === 'manifest') {
      const path = join(project, 'assets/shots/M01/manifest.json');
      const manifest = JSON.parse(readFileSync(path, 'utf8'));
      manifest.generation.source_shot = 'M03';
      json('assets/shots/M01/manifest.json', manifest);
    } else if (kind === 'video') writeFileSync(join(project, 'assets/shots/M01/derived-output/video.mp4'), 'replacement');
    else rmSync(join(project, 'assets/shots/M01'), { recursive: true });
    const changed = workflow.view(project, 'M01');
    expect(changed.preview?.fresh).toBe(true);
    expect(changed.preview?.accepted).toBe(false);
  });
});
