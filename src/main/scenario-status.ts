/** Общая проверка доступности сценария до чтения материалов производственных страниц. */
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { FPS } from '@shared/video';
import type { ScenarioStatus } from '@shared/scenario-status';
import type { ScenesFile } from '@shared/types';

type Json = Record<string, unknown>;

function object(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function frame(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

/** Проверяется только общий контракт реестра: художественную полноту оценивает страница сценария. */
export function readScenarioRegistry(project: string): { status: ScenarioStatus; registry: ScenesFile | null; sha256: string } {
  let raw: Buffer;
  try {
    raw = readFileSync(join(project, 'plan', 'scenes.json'));
  } catch (error) {
    return { status: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'missing' : 'invalid', registry: null, sha256: '' };
  }
  try {
    const registry: unknown = JSON.parse(raw.toString('utf8'));
    if (!object(registry) || registry.schema_version !== 1 || registry.fps !== FPS || !Array.isArray(registry.scenes))
      return { status: 'invalid', registry: null, sha256: '' };
    const ids = new Set<string>();
    for (const scene of registry.scenes) {
      if (!object(scene) || typeof scene.id !== 'string' || !/^M\d{2}(?:\.\d+)?$/.test(scene.id) || ids.has(scene.id))
        return { status: 'invalid', registry: null, sha256: '' };
      if (!frame(scene.start_frame) || !frame(scene.end_frame_exclusive) || scene.end_frame_exclusive <= scene.start_frame)
        return { status: 'invalid', registry: null, sha256: '' };
      ids.add(scene.id);
    }
    // Реестр и его снимок получены из одних байтов: повторное чтение могло бы захватить уже другую версию.
    return {
      status: registry.scenes.length ? 'ready' : 'empty',
      registry: registry as unknown as ScenesFile,
      sha256: createHash('sha256').update(raw).digest('hex')
    };
  } catch {
    return { status: 'invalid', registry: null, sha256: '' };
  }
}
