/** Сквозная сборка и приёмка используют штатные Jobs/PythonLauncher и реальные файлы без ИИ-настроек. */
import { createHash } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, expect, it, vi } from 'vitest';
import type { ScenesFile } from '@shared/types';
import { Jobs } from './jobs';
import { PythonLauncher } from './python-launcher';
import { DerivedWorkflow } from './derived-workflow';
import { projectFingerprints, shotAcceptance, writeAcceptedFingerprints } from './shot-acceptance';

const root = resolve(__dirname, '../..');
let directory: string | null = null;
const sha = (path: string): string => createHash('sha256').update(readFileSync(path)).digest('hex');
afterEach(() => {
  if (directory) rmSync(directory, { recursive: true, force: true });
});
it('проходит preview → отдельная приёмка → замена → аниматик и обнаруживает новую версию источника', async () => {
  directory = mkdtempSync(join(tmpdir(), 'songframe-derived-integration-'));
  const project = join(directory, 'Проект без генератора');
  cpSync(join(root, 'tools/testdata/sample-project'), project, { recursive: true });
  const registry = JSON.parse(readFileSync(join(project, 'plan/scenes.json'), 'utf8')) as ScenesFile;
  registry.scenes[0].derived_from = { shot: 'M02' };
  registry.scenes[0].lipsync = false;
  writeFileSync(join(project, 'plan/scenes.json'), JSON.stringify(registry));
  writeFileSync(
    join(project, 'plan/project.json'),
    JSON.stringify({ schema_version: 1, name: 'Без ИИ', animatic_video: 'check.mp4', generation: { image: null, video: null } })
  );
  writeAcceptedFingerprints(project, projectFingerprints(project, registry));
  const localDir = join(directory, 'local');
  const launcher = new PythonLauncher({ toolsRoot: root, localDir });
  const jobs = new Jobs(root, localDir, launcher, { restore: false });
  const workflow = new DerivedWorkflow(jobs);
  const beforeManifest = readFileSync(join(project, 'assets/shots/M01/manifest.json'));
  const sourceBefore = sha(join(project, 'assets/shots/M02/manifest.json'));
  const initial = workflow.view(project, 'M01');
  expect(initial.problem).toBeNull();
  const building = workflow.build(project, 'M01', { mode: 'repeat', start_frame: 0, end_frame_exclusive: 7 });
  await vi.waitFor(() => expect(jobs.get(building.job!.id)?.status).not.toBe('running'), { timeout: 30000, interval: 50 });
  expect(jobs.get(building.job!.id)).toMatchObject({ status: 'done' });
  expect(readFileSync(join(project, 'assets/shots/M01/manifest.json'))).toEqual(beforeManifest);
  const ready = workflow.view(project, 'M01');
  expect(ready.preview).toMatchObject({ fresh: true, frames: initial.targetFrames });
  const candidateSha = sha(ready.preview!.candidatePath);
  const accepting = workflow.accept(project, 'M01', ready.preview!.id, ready.preview!.resultToken, true);
  expect(accepting.job?.status).toBe('running');
  await vi.waitFor(() => expect(jobs.get(accepting.job!.id)?.status).not.toBe('running'), { timeout: 30000, interval: 50 });
  expect(jobs.get(accepting.job!.id), jobs.get(accepting.job!.id)?.error).toMatchObject({ status: 'done' });
  const accepted = workflow.view(project, 'M01');
  expect(accepted.preview?.accepted).toBe(true);
  const manifest = JSON.parse(readFileSync(join(project, 'assets/shots/M01/manifest.json'), 'utf8'));
  expect(manifest).toMatchObject({ kind: 'derived_video', generation: { source_shot: 'M02' }, accepted_edit: { frames: initial.targetFrames } });
  expect(sha(join(project, 'assets/shots/M01', manifest.accepted_edit.video.path))).toBe(candidateSha);
  expect(shotAcceptance(project, registry).accepted.get('M01')).toBe('completed');
  const retired = readdirSync(join(project, 'assets/replaced/M01'));
  expect(readFileSync(join(project, 'assets/replaced/M01', retired[0], 'manifest.json'))).toEqual(beforeManifest);
  expect(sha(join(project, 'assets/shots/M02/manifest.json'))).toBe(sourceBefore);
  const plan = await launcher.run(project, 'build_animatic', ['--plan-only']);
  expect(plan.code, plan.stderr).toBe(0);
  const replay = await launcher.run(project, 'asset_package', ['M01', '--from-original', '--output', join(directory, 'replayed.mp4')]);
  expect(replay.code, replay.stderr).toBe(0);
  const source = JSON.parse(readFileSync(join(project, 'assets/shots/M02/manifest.json'), 'utf8'));
  // Новое принятое видео при прежней постановке не освежает ранее принятый производный план.
  source.accepted_edit.video.path = 'replacement.mp4';
  cpSync(join(project, 'assets/shots/M02', source.generation.original.path), join(project, 'assets/shots/M02/replacement.mp4'));
  source.accepted_edit.video.sha256 = sha(join(project, 'assets/shots/M02/replacement.mp4'));
  writeFileSync(join(project, 'assets/shots/M02/manifest.json'), JSON.stringify(source));
  expect(shotAcceptance(project, registry).accepted.get('M01')).toBe('stale');
  expect(workflow.view(project, 'M01').preview?.fresh).toBe(false);
}, 60000);
