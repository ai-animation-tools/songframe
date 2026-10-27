/** Единый формат настроек медиа и сохранение вложенных расширений провайдеров. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { readProjectSettings, writeProjectSettings } from './checks';

let project: string;
let path: string;
const base = { schema_version: 1, name: 'Клип', animatic_video: 'clip.mp4' };
const video = {
  provider: 'kling',
  provider_selected: true,
  resolution: '1080p',
  aspect_ratio: '16:9',
  watermark: false,
  duration_rule: 'exact_window' as const,
  extension: { keep: true },
  options: { backend: { keep: 3 }, quality: 'high' }
};
const image = { provider: 'codex', provider_selected: true, model: 'image-model', options: { backend: { keep: 'image' } } };

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-checks-generation-'));
  mkdirSync(join(project, 'plan'));
  path = join(project, 'plan/project.json');
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

it('читает канонические блоки медиа без изменения файла', () => {
  const generation = { video, image, extension: { keep: 'generation' } };
  writeFileSync(path, JSON.stringify({ ...base, generation }));
  const raw = readFileSync(path, 'utf8');
  expect(readProjectSettings(project).generation).toEqual(generation);
  expect(readFileSync(path, 'utf8')).toBe(raw);
});

it('сохраняет вложенные расширения при изменении известных полей', () => {
  writeFileSync(path, JSON.stringify({ ...base, generation: { video, image, extension: { keep: 'generation' } }, extra: { keep: true } }));
  const saved = writeProjectSettings(project, {
    name: base.name,
    animaticVideo: base.animatic_video,
    generation: { video: { ...video, resolution: '720p', options: { quality: 'low' } }, image: { provider: 'codex' } }
  });
  expect(saved.generation).toEqual({
    video: { ...video, resolution: '720p', options: { backend: { keep: 3 }, quality: 'low' } },
    image,
    extension: { keep: 'generation' }
  });
  expect(JSON.parse(readFileSync(path, 'utf8')).extra).toEqual({ keep: true });
});

it('плоские поля не становятся настройками video/image и не разрешают запуск выбранного провайдера', () => {
  writeFileSync(path, JSON.stringify({ ...base, generation: video }));
  const raw = readFileSync(path, 'utf8');
  const settings = readProjectSettings(project);
  expect(settings.generation?.video).toBeNull();
  expect(settings.generation?.image).toBeNull();
  expect(readFileSync(path, 'utf8')).toBe(raw);
});
