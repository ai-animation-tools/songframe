/** Настоящий launcher читает spec из папки проекта, даже когда cwd принадлежит комплексу. */
import { cpSync, existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import type { MontageDraft } from '@shared/montage';
import type { JobInfo } from '@shared/types';
import { Jobs } from './jobs';
import { Montage } from './montage';

it('экспортирует ручной срез через настоящий PythonLauncher вне cwd проекта', async () => {
  const directory = mkdtempSync(join(tmpdir(), 'songframe-montage-integration-'));
  try {
    const project = join(directory, 'project');
    cpSync(resolve('tools/testdata/sample-project'), project, { recursive: true });
    const jobs = new Jobs(resolve('.'), join(directory, 'state'));
    const montage = new Montage(jobs);
    const view = montage.view(project);
    const draft: MontageDraft = {
      schema_version: 1,
      name: 'Проверка экспорта',
      audio: { path: 'source/track.mp3', start_frame: 240, end_frame_exclusive: 360 },
      clips: [
        {
          id: 'M02',
          scene: 'M02',
          path: 'assets/shots/M02/original.mp4',
          kind: 'video',
          source_start_frame: 5,
          source_end_frame_exclusive: 125,
          source_frames: 135
        }
      ],
      base_scenes_sha256: view.scenesSha256,
      base_manifest_sha256: view.manifestSha256
    };
    const finished = new Promise<JobInfo>((accept) => jobs.onFinished(accept));
    const result = montage.export(project, draft);
    const job = await finished;
    expect(job.status, job.log).toBe('done');
    expect(existsSync(join(project, result.video))).toBe(true);
    const recipe = JSON.parse(readFileSync(join(project, result.video.replace(/\.mp4$/, '.json')), 'utf8'));
    expect(recipe.total_frames).toBe(120);
    expect(recipe.audio.start_frame).toBe(240);
    expect(recipe.shots[0].source_start_frame).toBe(5);
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}, 30000);
