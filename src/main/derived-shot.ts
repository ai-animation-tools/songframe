/** Производный план (стоп-кадр, повтор, замедление другого плана) не готовится агентом и не генерируется. */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const SHOT_ID = /^M\d{2}(?:\.\d+)?$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/**
 * План-источник производного плана: поле derived_from реестра либо принятый комплект kind=derived_video
 * с generation.source_shot. Обычный план и нечитаемый комплект дают null.
 */
export function derivedShotSource(project: string, scene: unknown): string | null {
  if (!record(scene) || typeof scene.id !== 'string') return null;
  if (record(scene.derived_from) && typeof scene.derived_from.shot === 'string' && SHOT_ID.test(scene.derived_from.shot)) return scene.derived_from.shot;
  const path = join(project, 'assets', 'shots', scene.id, 'manifest.json');
  if (!existsSync(path)) return null;
  try {
    const manifest: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!record(manifest) || manifest.kind !== 'derived_video' || !record(manifest.generation)) return null;
    const source = manifest.generation.source_shot;
    return typeof source === 'string' && SHOT_ID.test(source) && source !== scene.id ? source : null;
  } catch {
    return null;
  }
}
