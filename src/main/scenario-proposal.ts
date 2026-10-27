/** Проверяет недоверенный JSON агента до обращения к доменным методам редактора. */
import { FPS } from '@shared/video';
import { isDeepStrictEqual } from 'node:util';
import type { CastFile, SceneShot, ScenesFile, TreatmentFile } from '@shared/types';
import type { ScenarioDocuments, ScenarioPass } from '@shared/scenario-workflow';
import { castReferences, normalizeCast } from './cast';
import { normalizeTreatment, resolveStates, validateScenes } from './scenario';

export const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const equal = isDeepStrictEqual;
export const STAGING_FIELDS = ['title', 'camera', 'action', 'continuity', 'notes', 'references', 'lipsync', 'card', 'state_from', 'state_changes'] as const;

/** Полная проверка вложенных полей нужна до validateScenes, который получает уже типизированный документ. */
export function checkScenesShape(value: unknown): asserts value is ScenesFile {
  if (
    !isRecord(value) ||
    value.schema_version !== 1 ||
    value.fps !== FPS ||
    typeof value.visual_direction !== 'string' ||
    !isRecord(value.audio) ||
    typeof value.audio.path !== 'string' ||
    typeof value.audio.end_seconds !== 'string' ||
    !isRecord(value.references) ||
    !Array.isArray(value.sequences) ||
    !Array.isArray(value.scenes)
  )
    throw new Error('Реестр: неверная структура документа.');
  for (const ref of Object.values(value.references)) {
    if (!isRecord(ref) || typeof ref.name !== 'string' || typeof ref.path !== 'string' || (ref.short_name !== undefined && typeof ref.short_name !== 'string'))
      throw new Error('Реестр: неверная карта референсов.');
  }
  for (const part of value.sequences) {
    if (!isRecord(part) || !['id', 'title', 'direction'].every((key) => typeof part[key] === 'string')) throw new Error('Реестр: неверные части песни.');
  }
  for (const scene of value.scenes) {
    if (
      !isRecord(scene) ||
      !['id', 'original', 'sequence', 'camera', 'action', 'continuity'].every((key) => typeof scene[key] === 'string') ||
      !Number.isInteger(scene.start_frame) ||
      !Number.isInteger(scene.end_frame_exclusive) ||
      !strings(scene.references) ||
      typeof scene.lipsync !== 'boolean' ||
      !isRecord(scene.card) ||
      typeof scene.card.primary_reference !== 'string' ||
      (scene.title !== undefined && typeof scene.title !== 'string') ||
      (scene.notes !== undefined && typeof scene.notes !== 'string')
    )
      throw new Error('Реестр: неверная структура плана.');
    const from = scene.state_from;
    if (
      from !== null &&
      typeof from !== 'string' &&
      !(isRecord(from) && typeof from.scene === 'string' && typeof from.phase === 'string' && ['before', 'after', 'same'].includes(from.phase))
    )
      throw new Error('Реестр: неверный state_from.');
    if (!isRecord(scene.state_changes) || Object.keys(scene.state_changes).some((key) => !['before', 'after'].includes(key)))
      throw new Error('Реестр: неверный state_changes.');
    for (const delta of Object.values(scene.state_changes)) {
      if (!isRecord(delta)) throw new Error('Реестр: изменения состояния должны быть объектом.');
      for (const attrs of Object.values(delta)) {
        if (!isRecord(attrs) || !Object.values(attrs).every((v) => v === null || typeof v === 'string'))
          throw new Error('Реестр: неверные свойства состояния.');
      }
    }
  }
}

export function checkTreatmentCast(cast: CastFile, treatment: TreatmentFile): void {
  const entities = new Set(cast.entities.map((entity) => entity.id));
  if (!treatment.logline.trim() || /ЗАПОЛНИТЬ/iu.test(treatment.logline)) throw new Error('Трактовка: заполните логлайн.');
  for (const part of treatment.sequences) {
    if (!part.direction.trim() || /ЗАПОЛНИТЬ/iu.test(part.direction)) throw new Error(`Часть ${part.id}: заполните постановку.`);
    for (const id of part.entities) if (!entities.has(id)) throw new Error(`Часть ${part.id}: неизвестная сущность ${id}.`);
  }
}

/** Строгая готовность применяется к предложению агента, сохраняя возможность ручных черновиков. */
export function checkReadyScenes(scenes: ScenesFile, cast: CastFile, duration: number): void {
  const problems = validateScenes(scenes, cast);
  if (Math.abs(Number(scenes.audio.end_seconds) - duration) >= 1 / FPS) problems.push('Конец реестра расходится с decoded duration.');
  if (!equal(scenes.references, castReferences(cast))) problems.push('Карта референсов должна соответствовать кастингу.');
  if (!scenes.visual_direction.trim() || /ЗАПОЛНИТЬ/iu.test(scenes.visual_direction)) problems.push('Заполните общую визуальную постановку.');
  const entities = new Map(cast.entities.map((entity) => [entity.id, entity]));
  for (const scene of scenes.scenes) {
    if (['camera', 'action', 'continuity'].some((key) => !String(scene[key as keyof SceneShot]).trim()) || /ЗАПОЛНИТЬ/iu.test(JSON.stringify(scene)))
      problems.push(`${scene.id}: осталась незаполненная постановка.`);
    for (const delta of Object.values(scene.state_changes)) {
      for (const [id, attrs] of Object.entries(delta)) {
        const entity = entities.get(id);
        if (!entity) problems.push(`${scene.id}: неизвестная сущность состояния ${id}.`);
        else {
          const known = new Set([...(cast.properties[entity.kind] ?? []).map((p) => p.key), ...Object.keys(entity.initial_state)]);
          for (const key of Object.keys(attrs)) if (!known.has(key)) problems.push(`${scene.id}: неизвестное свойство ${id}.${key}.`);
        }
      }
    }
  }
  if (problems.length) throw new Error(problems.join(' '));
}

export function proposalDocuments(
  raw: string,
  pass: ScenarioPass,
  before: ScenarioDocuments,
  scaffold: ScenesFile | null,
  selected: string[],
  duration: number,
  toolsRoot: string | null
): ScenarioDocuments {
  const value: unknown = JSON.parse(raw);
  if (!isRecord(value) || value.schemaVersion !== 1 || value.pass !== pass) throw new Error('Нужен один JSON-документ с schemaVersion 1 и ожидаемым pass.');
  const expectedKeys =
    pass === 'treatment'
      ? ['schemaVersion', 'pass', 'cast', 'treatment']
      : pass === 'scenes'
        ? ['schemaVersion', 'pass', 'scenes']
        : ['schemaVersion', 'pass', 'patches'];
  if (Object.keys(value).some((key) => !expectedKeys.includes(key))) throw new Error('В ответе есть поля вне контракта предложения.');
  if (pass === 'treatment') {
    const cast = normalizeCast(value.cast, toolsRoot);
    const treatment = normalizeTreatment(value.treatment, duration);
    checkTreatmentCast(cast, treatment);
    return { ...before, cast, treatment };
  }
  if (!before.cast) throw new Error('Нет кастинга для проверки реестра.');
  let scenes: ScenesFile;
  if (pass === 'scenes') {
    checkScenesShape(value.scenes);
    scenes = value.scenes;
    if (!scaffold || !equal(scenes.audio, scaffold.audio) || !equal(scenes.sequences, scaffold.sequences) || scenes.scenes.length !== scaffold.scenes.length)
      throw new Error('Ответ изменил исходный каркас реестра.');
    for (const [index, shot] of scenes.scenes.entries()) {
      for (const key of ['id', 'original', 'sequence', 'start_frame', 'end_frame_exclusive'] as const) {
        if (shot[key] !== scaffold.scenes[index][key]) throw new Error(`${shot.id}: нельзя менять ID, текст и кадровые окна каркаса.`);
      }
    }
  } else {
    if (!before.scenes || !Array.isArray(value.patches) || !value.patches.length) throw new Error('Нужен непустой список patches выбранных планов.');
    const seen = new Set<string>();
    const patches = new Map<string, Record<string, unknown>>();
    for (const patch of value.patches) {
      if (
        !isRecord(patch) ||
        typeof patch.id !== 'string' ||
        !selected.includes(patch.id) ||
        seen.has(patch.id) ||
        Object.keys(patch).length < 2 ||
        Object.keys(patch).some((key) => key !== 'id' && !(STAGING_FIELDS as readonly string[]).includes(key))
      )
        throw new Error('patches может менять только постановку выбранных неповторяющихся ID.');
      seen.add(patch.id);
      patches.set(patch.id, patch);
    }
    const candidate = { ...before.scenes, scenes: before.scenes.scenes.map((scene) => ({ ...scene, ...patches.get(scene.id) })) };
    checkScenesShape(candidate);
    scenes = candidate;
  }
  checkReadyScenes(scenes, before.cast, duration);
  return { ...before, scenes };
}

/** В preview отмечаем также планы, чьё наследуемое состояние изменилось вслед за выбранным. */
export function changedSceneIds(before: ScenarioDocuments, after: ScenarioDocuments): string[] {
  if (!after.scenes) return [];
  const previous = new Map(before.scenes?.scenes.map((scene) => [scene.id, scene]) ?? []);
  let beforeStates: ReturnType<typeof resolveStates> = {};
  // Некорректный прежний черновик не мешает проверить новый полный реестр.
  try {
    if (before.scenes) beforeStates = resolveStates(before.scenes, Object.fromEntries(before.cast?.entities.map((e) => [e.id, e.initial_state]) ?? []));
  } catch {
    /* Ошибка прежнего документа уже показана в problems. */
  }
  const afterStates = resolveStates(after.scenes, Object.fromEntries(after.cast?.entities.map((e) => [e.id, e.initial_state]) ?? []));
  return after.scenes.scenes
    .filter((scene) => !equal(previous.get(scene.id), scene) || !equal(beforeStates[scene.id], afterStates[scene.id]))
    .map((scene) => scene.id);
}
