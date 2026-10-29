/**
 * Состояние проекта вычисляется из файлов папки и нигде не хранится: приложение, инструменты и агент
 * видят одно и то же без синхронизации полей.
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import type { ProjectState, ProjectStatus, ScenesFile } from '@shared/types';
import { viewAnimatic } from './animatic';
import { shotAcceptance } from './shot-acceptance';

export const PROJECT_MARKER = join('plan', 'project.json');

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf-8'));
  } catch {
    return undefined;
  }
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function sha256Text(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

/** Папка считается проектом, если в ней есть plan/project.json с названием. */
export function readProjectMarker(path: string): { name: string; animaticVideo: string | null } | null {
  const data = readJson(join(path, PROJECT_MARKER));
  if (!isObject(data) || typeof data.name !== 'string' || !data.name) return null;
  return { name: data.name, animaticVideo: typeof data.animatic_video === 'string' ? data.animatic_video : null };
}

export function computeStatus(path: string): ProjectStatus {
  const problems: string[] = [];
  const checks: ProjectStatus['checks'] = {
    marker: false,
    sources: false,
    timing: false,
    cast: false,
    treatment: false,
    scenes: false,
    shotsTotal: 0,
    shotsDone: 0,
    animaticBuilt: false,
    animaticFresh: false,
    animaticApproved: false
  };
  const marker = existsSync(path) ? readProjectMarker(path) : null;
  if (!marker) {
    return { path, state: 'invalid', name: basename(path), animaticVideo: null, checks, problems: ['Нет plan/project.json с названием проекта.'] };
  }
  checks.marker = true;

  const manifest = readJson(join(path, 'source', 'manifest.json'));
  if (manifest !== undefined) {
    if (isObject(manifest) && isObject(manifest.track) && isObject(manifest.lyrics) && isObject(manifest.idea)) {
      checks.sources = true;
    } else {
      problems.push('source/manifest.json есть, но в нём нет трека, текста песни или идеи.');
    }
  } else if (existsSync(join(path, 'source', 'manifest.json'))) {
    problems.push('source/manifest.json повреждён.');
  }

  const timingPath = join(path, 'plan', 'audio', 'timing.json');
  if (existsSync(timingPath)) {
    const timing = readJson(timingPath);
    if (isObject(timing) && Array.isArray(timing.lines) && timing.lines.length > 0) checks.timing = true;
    else problems.push('plan/audio/timing.json не содержит строк разметки.');
  }

  const cast = readJson(join(path, 'plan', 'cast.json'));
  if (isObject(cast) && Array.isArray(cast.entities)) checks.cast = true;
  else if (existsSync(join(path, 'plan', 'cast.json'))) problems.push('plan/cast.json повреждён.');
  const treatment = readJson(join(path, 'plan', 'treatment.json'));
  if (isObject(treatment) && Array.isArray(treatment.sequences) && treatment.sequences.length > 0) checks.treatment = true;
  else if (existsSync(join(path, 'plan', 'treatment.json'))) problems.push('plan/treatment.json повреждён или пуст.');

  const scenesPath = join(path, 'plan', 'scenes.json');
  let sceneIds: string[] = [];
  let registry: ScenesFile | null = null;
  if (existsSync(scenesPath)) {
    const scenesText = readFileSync(scenesPath, 'utf-8');
    let scenes: unknown;
    try {
      scenes = JSON.parse(scenesText);
    } catch {
      scenes = undefined;
    }
    if (isObject(scenes) && Array.isArray(scenes.scenes) && scenes.scenes.length > 0) {
      sceneIds = scenes.scenes.filter(isObject).map((s) => String(s.id));
      registry = scenes as unknown as ScenesFile;
      checks.scenes = true;
    } else {
      problems.push('plan/scenes.json повреждён или не содержит сцен.');
    }
  }
  checks.shotsTotal = sceneIds.length;

  const shotsDir = join(path, 'assets', 'shots');
  let kits = 0;
  if (existsSync(shotsDir)) {
    const done = new Set(
      readdirSync(shotsDir, { withFileTypes: true })
        .filter((e) => e.isDirectory() && existsSync(join(shotsDir, e.name, 'manifest.json')))
        .map((e) => e.name)
    );
    kits = sceneIds.length ? sceneIds.filter((id) => done.has(id)).length : done.size;
    // Готовым считается только комплект, принятый по текущей постановке: правило общее со страницами планов.
    if (registry) {
      const acceptance = shotAcceptance(path, registry);
      if (acceptance.problem) problems.push(acceptance.problem);
      const stale = sceneIds.filter((id) => acceptance.accepted.get(id) === 'stale');
      checks.shotsDone = sceneIds.filter((id) => acceptance.accepted.get(id) === 'completed').length;
      if (stale.length) problems.push(`Постановка изменена после приёмки: ${stale.join(', ')}. Нужно новое производство этих планов.`);
    } else checks.shotsDone = done.size;
    const orphans = [...done].filter((id) => sceneIds.length && !sceneIds.includes(id));
    if (orphans.length) problems.push(`Комплекты без сцены в реестре: ${orphans.join(', ')}.`);
  }

  // Главная страница и плеер используют одну проверку фактических входов и принятия сборки.
  const animatic = viewAnimatic(path);
  checks.animaticBuilt = !!animatic.built;
  checks.animaticFresh = !!animatic.built?.fresh;
  checks.animaticApproved = animatic.approval.current;

  let state: ProjectState;
  if (!checks.sources) state = 'empty';
  else if (!checks.timing) state = 'sourced';
  else if (!checks.scenes) state = 'timed';
  else if (kits === 0) state = 'scripted';
  else if (checks.shotsDone < checks.shotsTotal) state = 'in_production';
  else if (checks.animaticBuilt && checks.animaticFresh && checks.animaticApproved) state = 'complete';
  else {
    state = 'in_production';
    if (!checks.animaticBuilt) problems.push('Все сцены приняты, но полный аниматик ещё не собран.');
    else if (!checks.animaticFresh) problems.push('Аниматик собран по устаревшему реестру или входам: нужна пересборка.');
    else problems.push('Аниматик собран, но не принят в plan/production-status.json.');
  }
  return { path, state, name: marker.name, animaticVideo: marker.animaticVideo, checks, problems };
}
