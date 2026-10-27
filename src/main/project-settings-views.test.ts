/** Сохранение настроек проверяется вместе с настоящим Python-потребителем на копии проекта. */
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { expect, it } from 'vitest';
import { readProjectSettings, writeProjectSettings } from './checks';

it('после настоящего saveSettings смена generation не требует обновления представлений', () => {
  const work = mkdtempSync(join(tmpdir(), 'songframe-settings-views-'));
  const project = join(work, 'Клип с пробелами');
  try {
    cpSync(resolve('tools/testdata/sample-project'), project, { recursive: true });
    const manifestPath = join(project, 'plan/animatic/latest/manifest.json');
    const runViews = (...args: string[]): string =>
      execFileSync('python3', ['-B', resolve('tools/update_scene_views/update_scene_views.py'), '--project', project, ...args], {
        encoding: 'utf8',
        env: { ...process.env, SONGFRAME_LOCAL_DIR: join(work, 'state') }
      });
    runViews();
    const receiptPath = join(project, 'plan/animatic/cards/manifest.json');
    const receiptBefore = readFileSync(receiptPath, 'utf8');
    const manifestBefore = readFileSync(manifestPath, 'utf8');
    const roadmap = readFileSync(join(project, 'ROADMAP.md'), 'utf8');
    const settings = readProjectSettings(project);
    settings.generation!.video!.model = 'kling-video-v4_0';
    settings.generation!.video!.provider_selected = true;
    settings.generation!.image = { provider: 'kling', provider_selected: true, model: 'test-image-model' };
    writeProjectSettings(project, settings);
    expect(JSON.parse(readFileSync(receiptPath, 'utf8')).project_inputs).toEqual({ name: settings.name });
    expect(JSON.parse(readFileSync(manifestPath, 'utf8')).project_inputs).toEqual({ name: settings.name, animatic_video: settings.animaticVideo });
    expect(readFileSync(receiptPath, 'utf8')).toBe(receiptBefore);
    expect(readFileSync(manifestPath, 'utf8')).toBe(manifestBefore);
    expect(() => runViews('--check')).not.toThrow();
    expect(readFileSync(join(project, 'ROADMAP.md'), 'utf8')).toBe(roadmap);
    // Повторное сохранение меняет только настройки: производные файлы остаются теми же.
    settings.generation!.video!.model = 'another-video-model';
    writeProjectSettings(project, settings);
    expect(() => runViews('--check')).not.toThrow();
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}, 15_000);
