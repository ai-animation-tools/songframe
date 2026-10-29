/**
 * Принятие плана привязано к постановке: комплект assets/shots/Mxx принят по отпечатку из
 * plan/production-status.json → shots.Mxx.scene_sha256. Единственное место правила для всех страниц
 * главного процесса; то же правило повторяют инструменты Python.
 */

import { existsSync, readFileSync, renameSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScenesFile } from '@shared/types';
import { initialStates, readCast } from './cast';
import { sceneFingerprints } from './scene-fingerprint';

export const PRODUCTION_STATUS = join('plan', 'production-status.json');

export type AcceptanceState = 'completed' | 'stale';

export interface ShotAcceptance {
  /** Отпечатки текущей постановки; null, если состояние реестра не вычисляется. */
  fingerprints: Record<string, string> | null;
  /** Только планы с принятым комплектом. */
  accepted: Map<string, AcceptanceState>;
  problem: string | null;
}

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Отпечатки, по которым приняты комплекты; отсутствующее поле shots означает, что принятых отпечатков нет. */
export function acceptedFingerprints(project: string): Record<string, string> {
  const status = readJson(join(project, PRODUCTION_STATUS));
  const shots = record(status) && record(status.shots) ? status.shots : {};
  const result: Record<string, string> = {};
  for (const [id, entry] of Object.entries(shots)) if (record(entry) && typeof entry.scene_sha256 === 'string') result[id] = entry.scene_sha256;
  return result;
}

/** Отпечатки по кастингу проекта: начальное состояние сущностей входит в унаследованное состояние плана. */
export function projectFingerprints(project: string, scenes: ScenesFile): Record<string, string> {
  return sceneFingerprints(scenes, initialStates(readCast(project) || null));
}

/** Комплект принят по текущей постановке; производный план устаревает вместе с планом-источником. */
export function shotAcceptance(project: string, scenes: ScenesFile): ShotAcceptance {
  let fingerprints: Record<string, string> | null = null;
  let problem: string | null = null;
  try {
    fingerprints = projectFingerprints(project, scenes);
  } catch (error) {
    problem = `Постановку планов не удалось сверить с принятыми комплектами: ${error instanceof Error ? error.message : String(error)}`;
  }
  const stored = acceptedFingerprints(project);
  const accepted = new Map<string, AcceptanceState>();
  for (const scene of scenes.scenes) {
    if (!existsSync(join(project, 'assets', 'shots', scene.id, 'manifest.json'))) continue;
    accepted.set(scene.id, fingerprints && stored[scene.id] === fingerprints[scene.id] ? 'completed' : 'stale');
  }
  // Цепочки derived_from запрещены реестром, поэтому достаточно одного прохода после своих отпечатков.
  for (const scene of scenes.scenes) {
    const source = scene.derived_from?.shot;
    if (source && accepted.get(scene.id) === 'completed' && accepted.get(source) === 'stale') accepted.set(scene.id, 'stale');
  }
  return { fingerprints, accepted, problem };
}

/** Содержимое файла для записи; повреждённый файл не перезаписываем: в нём и состояние принятия аниматика. */
export function writableProductionStatus(project: string): Record<string, unknown> | null {
  const path = join(project, PRODUCTION_STATUS);
  if (!existsSync(path)) return null;
  const current = readJson(path);
  if (!record(current)) throw new Error(`${PRODUCTION_STATUS} повреждён: исправьте файл, чтобы записать принятые отпечатки.`);
  return current;
}

/** Атомарно записывает отпечатки принятых планов, сохраняя прочие поля файла. */
export function writeAcceptedFingerprints(project: string, updates: Record<string, string>): void {
  if (!Object.keys(updates).length) return;
  const path = join(project, PRODUCTION_STATUS);
  const current = writableProductionStatus(project);
  const status: Record<string, unknown> = record(current) ? current : { schema_version: 1, current_animatic: null, current_animatic_status: 'none' };
  const shots: Record<string, unknown> = record(status.shots) ? { ...status.shots } : {};
  for (const [id, digest] of Object.entries(updates)) shots[id] = { ...(record(shots[id]) ? shots[id] : {}), scene_sha256: digest };
  status.shots = Object.fromEntries(Object.entries(shots).sort(([a], [b]) => Number(a.slice(1)) - Number(b.slice(1))));
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, JSON.stringify(status, null, 2) + '\n', 'utf-8');
  renameSync(temporary, path);
}

const fingerprintCache = new Map<string, { identity: string; fingerprints: Record<string, string> | null }>();

/** Отпечаток текущей постановки одного плана; кэш по изменению реестра и кастинга, null — реестр не вычисляется. */
export function currentShotFingerprint(project: string, shot: string): string | null {
  const files = [join(project, 'plan', 'scenes.json'), join(project, 'plan', 'cast.json')];
  const identity = files
    .map((file) => {
      try {
        const info = statSync(file, { bigint: true });
        return `${info.ino}:${info.size}:${info.mtimeNs}`;
      } catch {
        return '-';
      }
    })
    .join('|');
  let cached = fingerprintCache.get(project);
  if (cached?.identity !== identity) {
    let fingerprints: Record<string, string> | null;
    try {
      fingerprints = projectFingerprints(project, JSON.parse(readFileSync(files[0], 'utf-8')) as ScenesFile);
    } catch {
      fingerprints = null;
    }
    cached = { identity, fingerprints };
    if (fingerprintCache.size >= 64) fingerprintCache.clear();
    fingerprintCache.set(project, cached);
  }
  return cached.fingerprints?.[shot] ?? null;
}

/** Меняет только отпечаток в workflow.json пакета, сохраняя остальной текст файла байт в байт. */
export function restampPackage(directory: string, from: string | null, to: string): boolean {
  const path = join(directory, 'workflow.json');
  const text = readFileSync(path, 'utf-8');
  const pattern = new RegExp(`("scene_sha256"\\s*:\\s*)${from === null ? 'null' : `"${from}"`}`);
  if (!pattern.test(text)) return false;
  const temporary = `${path}.tmp`;
  writeFileSync(temporary, text.replace(pattern, `$1"${to}"`), 'utf-8');
  renameSync(temporary, path);
  return true;
}
