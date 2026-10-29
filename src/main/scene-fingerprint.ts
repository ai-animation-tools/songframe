/**
 * Отпечаток постановки плана как scene_fingerprint в tools/scene_registry: план, направление его части,
 * общие правила и вычисленное состояние. По нему пакет и принятый комплект узнают, что постановка изменилась.
 */

import { createHash } from 'node:crypto';
import type { EntityState, ScenesFile } from '@shared/types';
import { resolveStates } from './scenario';

/** Повторяет json.dumps(sort_keys=True, ensure_ascii=False, separators=(",", ":")) для данных реестра. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, item]) => item !== undefined);
    entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  // Целые и строки сериализуются одинаково; дробных чисел в постановке плана нет.
  return JSON.stringify(value ?? null);
}

/** Отпечатки всех планов за одно вычисление состояния; ошибка состояния делает реестр непригодным. */
export function sceneFingerprints(data: ScenesFile, initial: EntityState): Record<string, string> {
  const states = resolveStates(data, initial);
  const directions = new Map((data.sequences ?? []).map((sequence) => [sequence.id, sequence.direction ?? '']));
  return Object.fromEntries(
    data.scenes.map((scene) => {
      const context = {
        scene,
        sequence_direction: directions.get(scene.sequence) ?? '',
        visual_direction: data.visual_direction ?? '',
        state: states[scene.id]
      };
      return [scene.id, createHash('sha256').update(canonicalJson(context), 'utf8').digest('hex')];
    })
  );
}
