/**
 * Сохранение реестра с учётом производства: какие планы меняют отпечаток постановки и как с ними поступить.
 * Обычное сохранение делает принятые комплекты затронутых планов устаревшими; режим keep оставляет их в силе.
 */

import { scenarioTexts } from '@shared/texts/scenario';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ScenarioImpactShot, ScenarioSaveImpact, SceneShot, ScenesFile, ScenesSaveMode } from '@shared/types';
import { initialStates, readCast } from './cast';
import { viewProduction } from './production';
import { resolveStates, saveScenes } from './scenario';
import { acceptedFingerprints, projectFingerprints, restampPackage, writableProductionStatus, writeAcceptedFingerprints } from './shot-acceptance';

function readRegistry(project: string): ScenesFile | null {
  try {
    return JSON.parse(readFileSync(join(project, 'plan', 'scenes.json'), 'utf-8')) as ScenesFile;
  } catch {
    return null;
  }
}

function fingerprintsOf(project: string, scenes: ScenesFile | null): Record<string, string> | null {
  if (!scenes) return null;
  try {
    return projectFingerprints(project, scenes);
  } catch {
    return null;
  }
}

const withoutBounds = ({ start_frame: _start, end_frame_exclusive: _end, ...rest }: SceneShot): unknown => rest;

/** Формальная причина изменения отпечатка; смысловые связи свободного текста здесь не угадываются. */
function reasonOf(project: string, before: ScenesFile, after: ScenesFile, id: string): string {
  const previous = before.scenes.find((scene) => scene.id === id);
  const next = after.scenes.find((scene) => scene.id === id)!;
  if (!previous) return scenarioTexts.main.impactNewShot;
  if (JSON.stringify(withoutBounds(previous)) !== JSON.stringify(withoutBounds(next))) return scenarioTexts.main.impactStagingChanged;
  if (previous.start_frame !== next.start_frame || previous.end_frame_exclusive !== next.end_frame_exclusive) return scenarioTexts.main.impactBoundsChanged;
  const initial = initialStates(readCast(project) || null);
  if (JSON.stringify(resolveStates(before, initial)[id]) !== JSON.stringify(resolveStates(after, initial)[id])) {
    const source = typeof next.state_from === 'string' ? next.state_from : (next.state_from?.scene ?? null);
    return source ? scenarioTexts.main.impactInheritedState({ source }) : scenarioTexts.main.impactInitialState;
  }
  return scenarioTexts.main.impactGlobalRules;
}

/** Планы, чей отпечаток различается у сохранённого реестра и черновика, плюс производные от них планы. */
function affectedShots(project: string, before: ScenesFile | null, after: ScenesFile): { id: string; reason: string }[] {
  const previous = fingerprintsOf(project, before);
  const next = fingerprintsOf(project, after);
  if (!before || !previous || !next) return [];
  const changed = new Map<string, string>();
  for (const scene of after.scenes) if (previous[scene.id] !== next[scene.id]) changed.set(scene.id, reasonOf(project, before, after, scene.id));
  for (const scene of after.scenes) {
    const source = scene.derived_from?.shot;
    if (source && changed.has(source) && !changed.has(scene.id)) changed.set(scene.id, scenarioTexts.main.impactDerivedSource({ source }));
  }
  return after.scenes.filter((scene) => changed.has(scene.id)).map((scene) => ({ id: scene.id, reason: changed.get(scene.id)! }));
}

/** Что затронет сохранение черновика: статусы берутся из того же производственного вида, что и на страницах планов. */
export function scenesSaveImpact(project: string, draft: ScenesFile): ScenarioSaveImpact {
  const affected = affectedShots(project, readRegistry(project), draft);
  if (!affected.length) return { shots: [] };
  const production = new Map(viewProduction(project).shots.map((shot) => [shot.id, shot]));
  const shots: ScenarioImpactShot[] = affected.map(({ id, reason }) => {
    const shot = production.get(id);
    return { id, reason, state: shot?.state ?? 'planned', produced: !!shot && (!!shot.asset || shot.packages.length > 0) };
  });
  return { shots };
}

/** Пакет хранит отпечаток в workflow.json; заменяем только это значение, не переписывая остальной файл. */
function restampPackages(project: string, shots: Set<string>, previous: Record<string, string>, next: Record<string, string>): void {
  for (const base of ['plan/batches', 'plan/awaiting']) {
    const folder = join(project, base);
    if (!existsSync(folder)) continue;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      let workflow: { shot?: unknown; stage?: unknown; scene_sha256?: unknown };
      try {
        workflow = JSON.parse(readFileSync(join(folder, entry.name, 'workflow.json'), 'utf-8')) as typeof workflow;
      } catch {
        continue;
      }
      const shot = typeof workflow.shot === 'string' ? workflow.shot : '';
      if (!shots.has(shot) || workflow.stage === 'accepted' || workflow.scene_sha256 !== previous[shot]) continue;
      restampPackage(join(folder, entry.name), previous[shot], next[shot]);
    }
  }
}

/**
 * production: затронутые принятые планы становятся устаревшими сами, по несовпадению отпечатков.
 * keep: планы, принятые и подготовленные по прежней постановке, получают новый отпечаток; ранее устаревшие
 * остаются устаревшими, чтобы правка опечатки не отменяла прежнюю сюжетную правку.
 */
export function saveScenesWithMode(project: string, data: ScenesFile, mode: ScenesSaveMode): ScenesFile {
  if (mode !== 'production' && mode !== 'keep') throw new Error(scenarioTexts.main.invalidSaveMode);
  // Проверяем файл принятых отпечатков до записи реестра, чтобы не оставить полусохранение.
  if (mode === 'keep') writableProductionStatus(project);
  const before = readRegistry(project);
  const previous = fingerprintsOf(project, before);
  const saved = saveScenes(project, data);
  if (mode === 'production' || !previous) return saved;
  const next = fingerprintsOf(project, saved);
  if (!next) return saved;
  const affected = new Set(affectedShots(project, before, saved).map((shot) => shot.id));
  const stored = acceptedFingerprints(project);
  const updates: Record<string, string> = {};
  for (const id of affected) if (stored[id] && stored[id] === previous[id] && next[id]) updates[id] = next[id];
  writeAcceptedFingerprints(project, updates);
  restampPackages(project, affected, previous, next);
  return saved;
}
