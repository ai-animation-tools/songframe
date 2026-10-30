/**
 * Сценарий в главном процессе: трактовка, реестр сцен, вычисление состояния и врезка непрерывности.
 * Алгоритмы повторяют tools/scene_registry и tools/continuity_brief, чтобы редактор работал без Python.
 */

import { scenarioTexts } from '@shared/texts/scenario';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  BriefResult,
  CastFile,
  EntityState,
  ResolvedState,
  ScenarioView,
  SceneShot,
  ScenesFile,
  StateSource,
  TimingFile,
  TreatmentFile
} from '@shared/types';
import { castReferences, initialStates, loadDefaults, readCast, WORLD_ID } from './cast';
import { readManifest } from './sources';
import { parseLyricsLines } from './timing';
import { FPS } from '@shared/video';
import { BRIEF_STATE_UNSET_PREFIX } from '@shared/types';

const SLUG = /^[a-z][a-z0-9_]*$/;
const SCENE_ID = /^M\d{2}(\.\d+)?$/;

function readJson<T>(path: string): T | null | false {
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return false;
  }
}

export function viewScenario(project: string, toolsRoot: string | null): ScenarioView {
  const problems: string[] = [];
  const read = <T>(relative: string, label: string): T | null => {
    const value = readJson<T>(join(project, relative));
    if (value === false) problems.push(scenarioTexts.main.damagedDocument({ label }));
    return value || null;
  };
  const scenes = read<ScenesFile>('plan/scenes.json', 'plan/scenes.json');
  const treatment = read<TreatmentFile>('plan/treatment.json', 'plan/treatment.json');
  const timing = read<TimingFile>('plan/audio/timing.json', 'plan/audio/timing.json');
  let cast = readCast(project);
  if (cast === false) {
    problems.push(scenarioTexts.main.damagedCast);
    cast = null;
  }
  const manifest = readManifest(project);
  const textPath = join(project, 'source', 'text.md');
  const trackPath = join(project, 'source', 'track.mp3');
  if (scenes) {
    problems.push(...validateScenes(scenes, cast));
    if (cast && JSON.stringify(scenes.references) !== JSON.stringify(castReferences(cast))) problems.push(scenarioTexts.main.referencesRefresh);
  }
  void loadDefaults(toolsRoot);
  return {
    scenes,
    treatment,
    cast,
    timing,
    lyrics: existsSync(textPath) ? parseLyricsLines(readFileSync(textPath, 'utf-8')) : [],
    duration: timing?.duration_decoded ?? manifest?.track?.duration_seconds ?? timing?.duration_container ?? null,
    trackPath: existsSync(trackPath) ? trackPath : null,
    problems
  };
}

export function validateTreatment(treatment: TreatmentFile, duration: number | null): string[] {
  const problems: string[] = [];
  if (treatment.schema_version !== 1 || !Array.isArray(treatment.sequences) || !treatment.sequences.length) return [scenarioTexts.main.treatmentRequiresParts];
  const sorted = [...treatment.sequences].sort((a, b) => a.start - b.start);
  const ids = new Set<string>();
  let cursor = 0;
  for (const part of sorted) {
    if (!SLUG.test(part.id)) problems.push(scenarioTexts.main.partCodeLatin({ title: part.title || part.id }));
    if (ids.has(part.id)) problems.push(scenarioTexts.main.duplicatePartCode({ id: part.id }));
    ids.add(part.id);
    if (!part.title.trim()) problems.push(scenarioTexts.main.partTitleMissing({ id: part.id }));
    if (Math.abs(part.start - cursor) > 0.06)
      problems.push(scenarioTexts.main.partStartMismatch({ id: part.id, start: part.start, previousEnd: cursor.toFixed(2) }));
    if (part.end <= part.start) problems.push(scenarioTexts.main.partEndsBeforeStart({ id: part.id }));
    cursor = part.end;
  }
  if (duration && Math.abs(cursor - duration) > 0.06)
    problems.push(scenarioTexts.main.treatmentDurationMismatch({ end: cursor.toFixed(2), duration: duration.toFixed(2) }));
  return problems;
}

/** Нормализация предложения не пишет файлы и отклоняет неверные типы до сортировки и trim. */
export function normalizeTreatment(value: unknown, duration: number | null): TreatmentFile {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  if (!record(value) || value.schema_version !== 1 || typeof value.logline !== 'string' || !Array.isArray(value.sequences))
    throw new Error(scenarioTexts.main.treatmentInvalidDocument);
  for (const part of value.sequences) {
    if (
      !record(part) ||
      !['id', 'title', 'direction'].every((key) => typeof part[key] === 'string') ||
      typeof part.start !== 'number' ||
      !Number.isFinite(part.start) ||
      typeof part.end !== 'number' ||
      !Number.isFinite(part.end) ||
      !Array.isArray(part.entities) ||
      !part.entities.every((id) => typeof id === 'string') ||
      (part.lipsync !== undefined && typeof part.lipsync !== 'boolean') ||
      (part.max_shot_seconds !== undefined &&
        (typeof part.max_shot_seconds !== 'number' || !Number.isFinite(part.max_shot_seconds) || part.max_shot_seconds <= 0))
    )
      throw new Error(scenarioTexts.main.treatmentInvalidPart);
  }
  const treatment = value as unknown as TreatmentFile;
  const normalized: TreatmentFile = {
    schema_version: 1,
    logline: treatment.logline.trim(),
    sequences: [...treatment.sequences]
      .sort((a, b) => a.start - b.start)
      .map((s) => ({
        ...s,
        title: s.title.trim(),
        direction: s.direction.trim(),
        start: round(s.start),
        end: round(s.end),
        entities: s.entities.filter(Boolean)
      }))
  };
  const problems = validateTreatment(normalized, duration);
  if (problems.length) throw new Error(problems.join(' '));
  return normalized;
}

export function saveTreatment(project: string, treatment: TreatmentFile): TreatmentFile {
  const view = viewScenario(project, null);
  const normalized = normalizeTreatment(treatment, view.duration);
  mkdirSync(join(project, 'plan'), { recursive: true });
  writeFileSync(join(project, 'plan', 'treatment.json'), JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
  return normalized;
}

/** Структурная проверка реестра как в scene_registry.validate плюс читаемые сообщения для редактора. */
export function validateScenes(data: ScenesFile, cast: CastFile | null): string[] {
  const problems: string[] = [];
  if (data.schema_version !== 1 || data.fps !== FPS || !Array.isArray(data.scenes) || !data.scenes.length)
    return [scenarioTexts.main.registryRequiresScenes({ fps: FPS })];
  const groups = new Set(data.sequences.map((s) => s.id));
  const seen = new Set<string>();
  let end = 0;
  for (const scene of data.scenes) {
    const sid = scene.id;
    if (!SCENE_ID.test(sid)) problems.push(scenarioTexts.main.shotCodeInvalid({ shot: sid }));
    if (seen.has(sid)) problems.push(scenarioTexts.main.duplicateShotCode({ shot: sid }));
    seen.add(sid);
    if (!Number.isInteger(scene.start_frame) || !Number.isInteger(scene.end_frame_exclusive))
      problems.push(scenarioTexts.main.shotFramesInteger({ shot: sid }));
    else {
      if (scene.start_frame !== end) problems.push(scenarioTexts.main.shotStartMismatch({ shot: sid, start: scene.start_frame, previousEnd: end }));
      if (scene.end_frame_exclusive <= scene.start_frame) problems.push(scenarioTexts.main.shotEndsBeforeStart({ shot: sid }));
      end = scene.end_frame_exclusive;
    }
    if (!groups.has(scene.sequence)) problems.push(scenarioTexts.main.shotUnknownPart({ shot: sid, part: scene.sequence }));
    if (!scene.camera?.trim()) problems.push(scenarioTexts.main.shotCameraMissing({ shot: sid }));
    if (!scene.action?.trim()) problems.push(scenarioTexts.main.shotActionMissing({ shot: sid }));
    for (const ref of scene.references)
      if (ref !== '—' && !data.references[ref]) problems.push(scenarioTexts.main.shotUnknownReference({ shot: sid, reference: ref }));
    if (!data.references[scene.card?.primary_reference]) problems.push(scenarioTexts.main.shotPrimaryReferenceMissing({ shot: sid }));
  }
  problems.push(...derivedFromProblems(data.scenes));
  const endSeconds = Number(data.audio?.end_seconds);
  if (!Number.isFinite(endSeconds) || Math.abs(end / FPS - endSeconds) >= 1 / FPS)
    problems.push(scenarioTexts.main.registryDurationMismatch({ end: (end / FPS).toFixed(3), duration: data.audio?.end_seconds }));
  try {
    resolveStates(data, initialStates(cast));
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  return problems;
}

/** Порт derived_from_problems: производный план ссылается на существующий план с собственной генерацией. */
export function derivedFromProblems(scenes: SceneShot[]): string[] {
  const byId = new Map(scenes.map((scene) => [scene.id, scene]));
  const problems: string[] = [];
  for (const scene of scenes) {
    // Пустое значение редактора (undefined) не попадает в JSON и означает обычный план.
    if (scene.derived_from === undefined) continue;
    const value: unknown = scene.derived_from;
    const source =
      value && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).join() === 'shot' ? (value as { shot: unknown }).shot : null;
    if (typeof source !== 'string' || !SCENE_ID.test(source)) problems.push(scenarioTexts.main.derivedInvalidShape({ shot: scene.id }));
    else if (source === scene.id) problems.push(scenarioTexts.main.derivedSelfReference({ shot: scene.id }));
    else if (!byId.has(source)) problems.push(scenarioTexts.main.derivedUnknownSource({ shot: scene.id, source }));
    else if (byId.get(source)!.derived_from !== undefined) problems.push(scenarioTexts.main.derivedChainedSource({ shot: scene.id, source }));
  }
  return problems;
}

/** Порт _resolve_states: наследование состояния по state_from с начальным состоянием кастинга. */
export function resolveStates(data: ScenesFile, initial: EntityState): Record<string, ResolvedState> {
  return Object.fromEntries(
    Object.entries(resolveTracked(data, initial)).map(([sid, value]) => [sid, { before: plain(value.before), after: plain(value.after) }])
  );
}

/** Состояние до правок блока плана: для первого кадра — пришедшее по state_from, для итога — первый кадр. */
export function resolveInherited(data: ScenesFile, initial: EntityState): Record<string, ResolvedState> {
  return Object.fromEntries(
    Object.entries(resolveTracked(data, initial)).map(([sid, value]) => [sid, { before: plain(value.incoming), after: plain(value.before) }])
  );
}

function plain(state: Tracked): EntityState {
  return Object.fromEntries(
    Object.entries(state).map(([entity, attributes]) => [entity, Object.fromEntries(Object.entries(attributes).map(([key, item]) => [key, item.value]))])
  );
}

/** Где задано каждое значение вычисленного состояния: для перехода к месту правки из врезки. */
export function resolveStateSources(
  data: ScenesFile,
  initial: EntityState
): Record<string, Record<'before' | 'after', Record<string, Record<string, StateSource>>>> {
  const sources = (state: Tracked): Record<string, Record<string, StateSource>> =>
    Object.fromEntries(
      Object.entries(state).map(([entity, attributes]) => [entity, Object.fromEntries(Object.entries(attributes).map(([key, item]) => [key, item.source]))])
    );
  return Object.fromEntries(
    Object.entries(resolveTracked(data, initial)).map(([sid, value]) => [sid, { before: sources(value.before), after: sources(value.after) }])
  );
}

type Tracked = Record<string, Record<string, { value: string; source: StateSource }>>;

/** Значение несёт свой источник; порядок ключей и правила совпадают с _resolve_states, от них зависит отпечаток плана. */
function resolveTracked(data: ScenesFile, initial: EntityState): Record<string, { before: Tracked; after: Tracked; incoming: Tracked }> {
  const scenes = new Map(data.scenes.map((s) => [s.id, s]));
  const previous = new Map(data.scenes.map((s, i) => [s.id, i ? data.scenes[i - 1].id : null]));
  const resolved = new Map<string, { before: Tracked; after: Tracked; incoming: Tracked }>();
  const visiting: string[] = [];
  const clone = (state: Tracked): Tracked =>
    Object.fromEntries(
      Object.entries(state).map(([entity, attributes]) => [entity, Object.fromEntries(Object.entries(attributes).map(([key, item]) => [key, { ...item }]))])
    );
  const start: Tracked = Object.fromEntries(
    Object.entries(initial).map(([entity, attributes]) => [
      entity,
      Object.fromEntries(Object.entries(attributes).map(([key, value]) => [key, { value, source: { kind: 'cast' } as StateSource }]))
    ])
  );

  const apply = (state: Tracked, delta: SceneShot['state_changes']['before'], sid: string, phase: 'before' | 'after'): Tracked => {
    const result = clone(state);
    if (!delta) return result;
    if (typeof delta !== 'object' || Array.isArray(delta)) throw new Error(scenarioTexts.main.stateChangesInvalid({ shot: sid }));
    for (const [entity, attributes] of Object.entries(delta)) {
      if (!SLUG.test(entity) || typeof attributes !== 'object' || attributes === null || Array.isArray(attributes))
        throw new Error(scenarioTexts.main.stateEntityInvalid({ shot: sid, entity }));
      for (const [key, value] of Object.entries(attributes)) {
        if (!SLUG.test(key) || (value !== null && (typeof value !== 'string' || !value.trim())))
          throw new Error(scenarioTexts.main.statePropertyInvalid({ shot: sid, entity, property: key }));
        if (value === null) {
          if (result[entity]) delete result[entity][key];
        } else {
          result[entity] = result[entity] ?? {};
          result[entity][key] = { value, source: { kind: 'plan', shot: sid, phase } };
        }
      }
      if (result[entity] && !Object.keys(result[entity]).length) delete result[entity];
    }
    return result;
  };

  const visit = (sid: string): { before: Tracked; after: Tracked; incoming: Tracked } => {
    const done = resolved.get(sid);
    if (done) return done;
    if (visiting.includes(sid)) throw new Error(scenarioTexts.main.stateCycle({ chain: [...visiting, sid].join(' → ') }));
    const scene = scenes.get(sid);
    if (!scene) throw new Error(scenarioTexts.main.stateUnknownSource({ shot: sid }));
    visiting.push(sid);
    let source: string | null =
      scene.state_from === undefined
        ? (previous.get(sid) ?? null)
        : typeof scene.state_from === 'object' && scene.state_from !== null
          ? scene.state_from.scene
          : scene.state_from;
    let phase: 'before' | 'after' | 'same' = typeof scene.state_from === 'object' && scene.state_from !== null ? scene.state_from.phase : 'after';
    if (source === null && phase !== 'after') throw new Error(scenarioTexts.main.stateInvalidPhase({ shot: sid }));
    if (source !== null && typeof source !== 'string') {
      source = null;
      phase = 'after';
    }
    const changes = scene.state_changes ?? {};
    const incoming = source !== null ? visit(source) : { before: clone(start), after: clone(start), incoming: clone(start) };
    // incoming — состояние до правок первого кадра плана: от него видно, что план действительно меняет.
    let value: { before: Tracked; after: Tracked; incoming: Tracked };
    if (phase === 'same') {
      if (changes.before || changes.after) throw new Error(scenarioTexts.main.stateSameHasChanges({ shot: sid }));
      value = { before: clone(incoming.before), after: clone(incoming.after), incoming: clone(incoming.before) };
    } else {
      const before = apply(incoming[phase], changes.before, sid, 'before');
      value = { before, after: apply(before, changes.after, sid, 'after'), incoming: clone(incoming[phase]) };
    }
    visiting.pop();
    resolved.set(sid, value);
    return value;
  };
  for (const sid of scenes.keys()) visit(sid);
  return Object.fromEntries(resolved);
}

/** Сохраняет реестр: references из кастинга, проверка структуры и состояния. */
export function saveScenes(project: string, data: ScenesFile): ScenesFile {
  let cast = readCast(project);
  if (cast === false) cast = null;
  const normalized: ScenesFile = { ...data, references: cast ? castReferences(cast) : data.references };
  const problems = validateScenes(normalized, cast);
  if (problems.length) throw new Error(problems.join(' '));
  mkdirSync(join(project, 'plan'), { recursive: true });
  writeFileSync(join(project, 'plan', 'scenes.json'), JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
  return normalized;
}

/** Врезка непрерывности как в continuity_brief: мир первым, подписи из словаря, чек-лист по шаблонам. */
export function buildBrief(data: ScenesFile, cast: CastFile | null, sid: string, phase: 'before' | 'after', toolsRoot: string | null): BriefResult {
  const states = resolveStates(data, initialStates(cast));
  const state = states[sid]?.[phase];
  const sources = resolveStateSources(data, initialStates(cast))[sid]?.[phase] ?? {};
  const inherited = resolveInherited(data, initialStates(cast))[sid]?.[phase] ?? {};
  const scene = data.scenes.find((s) => s.id === sid);
  if (!state || !scene) throw new Error(scenarioTexts.main.briefShotMissing({ shot: sid }));
  const defaults = loadDefaults(toolsRoot);
  const names = new Map((cast?.entities ?? []).map((e) => [e.id, { name: e.name, kind: e.kind }]));
  const vocab = new Map<string, Map<string, { label: string; checklist?: string }>>();
  for (const [kind, items] of Object.entries(cast?.properties ?? {})) vocab.set(kind, new Map(items.map((p) => [p.key, p])));
  for (const entity of cast?.entities ?? []) if (!vocab.has(entity.kind)) vocab.set(entity.kind, new Map(defaults.generic.map((p) => [p.key, p])));
  const known = (cast?.entities ?? []).map((e) => e.id).filter((id) => state[id]);
  known.sort((a, b) => (a === WORLD_ID ? 0 : 1) - (b === WORLD_ID ? 0 : 1));
  const order = [
    ...known,
    ...Object.keys(state)
      .filter((id) => !names.has(id))
      .sort()
  ];
  const description: string[] = [];
  const checklist: string[] = [];
  const labels: Record<string, Record<string, string>> = {};
  for (const [entity, attributes] of Object.entries(state)) {
    const info = names.get(entity);
    const props = info ? vocab.get(info.kind) : undefined;
    for (const key of Object.keys(attributes)) {
      const label = props?.get(key)?.label;
      if (label) (labels[entity] ??= {})[key] = label;
    }
  }
  for (const eid of order) {
    const info = names.get(eid);
    const props = info ? vocab.get(info.kind) : undefined;
    const parts: string[] = [];
    for (const [key, value] of Object.entries(state[eid])) {
      const prop = props?.get(key);
      parts.push(`${(prop?.label ?? key.replace(/_/g, ' ')).toLowerCase()}: ${value}`);
      if (prop?.checklist) checklist.push(`${info?.name ?? eid}: ${prop.checklist.replace('{value}', value)}`);
    }
    description.push(`${info?.name ?? eid}: ${parts.join('; ')}.`);
  }
  // eslint-disable-next-line no-restricted-syntax -- Заголовок входит в формат continuity_brief, совпадающий с Python-инструментом.
  const title = phase === 'before' ? 'Состояние на первый кадр' : 'Состояние на последний кадр';
  // eslint-disable-next-line no-restricted-syntax -- Абзац передаётся в производственный промпт как данные непрерывности.
  const paragraph = description.length ? `${title} ${sid}. ${description.join(' ')}` : `${title} ${sid}: состояние не задано.`;
  const text = [
    `${title} ${sid} (${scene.action.slice(0, 80)}${scene.action.length > 80 ? '…' : ''})`,
    '',
    // eslint-disable-next-line no-restricted-syntax -- Строка формата brief; префикс распознаётся в ShotStateBlock, первые две строки убирает dashboard.
    ...(description.length ? description : [`${BRIEF_STATE_UNSET_PREFIX}: в кастинге нет начального состояния, а в сценах нет изменений.`])
  ];
  // eslint-disable-next-line no-restricted-syntax -- Заголовок списка входит в Markdown-формат continuity_brief для производства.
  if (checklist.length) text.push('', 'Проверить по кадру:', ...checklist.map((q) => `- [ ] ${q}`));
  return { shot: sid, phase, state, sources, labels, inherited, paragraph, checklist, text: text.join('\n') };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
