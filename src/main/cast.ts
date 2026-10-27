/**
 * Кастинг plan/cast.json в главном процессе: чтение, создание из исходников, проверка и запись.
 * Словарь свойств по умолчанию общий с инструментами: tools/cast_registry/default_properties.json.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { CastEntity, CastFile, CastProperty, CastView, SourceManifest } from '@shared/types';
import { readManifest } from './sources';

const SLUG = /^[a-z][a-z0-9_]*$/;
export const WORLD_ID = 'world';

interface Defaults {
  default: Record<string, CastProperty[]>;
  generic: CastProperty[];
  world: CastEntity;
}

const FALLBACK: Defaults = {
  default: {},
  generic: [
    { key: 'position', label: 'Положение', hint: 'Где находится и относительно чего', checklist: 'Положение: {value}?' },
    { key: 'condition', label: 'Состояние', hint: 'Внешний вид и изменения по сюжету', checklist: 'Состояние: {value}?' },
    {
      key: 'marks',
      label: 'Сквозные метки',
      hint: 'Детали, которые должны повторяться дальше, с указанием сцены',
      checklist: 'Сквозные метки на месте: {value}?'
    },
    { key: 'note', label: 'Заметка', hint: 'Прочее' }
  ],
  world: {
    id: WORLD_ID,
    kind: 'world',
    name: 'Мир сцены',
    short_name: 'Мир',
    role: 'Общие условия: время, погода, стороны дороги',
    appearance: '',
    images: [],
    initial_state: {}
  }
};

let cachedDefaults: Defaults | null = null;

/** Словарь по умолчанию из комплекса; без комплекса остаётся общий набор. */
export function loadDefaults(toolsRoot: string | null): Defaults {
  if (cachedDefaults) return cachedDefaults;
  if (toolsRoot) {
    try {
      cachedDefaults = JSON.parse(readFileSync(join(toolsRoot, 'tools', 'cast_registry', 'default_properties.json'), 'utf-8')) as Defaults;
      return cachedDefaults;
    } catch {
      /* комплекс без файла словаря: общий набор */
    }
  }
  return FALLBACK;
}

export function validateCast(cast: CastFile): string[] {
  const problems: string[] = [];
  if (cast.schema_version !== 1 || !Array.isArray(cast.entities) || typeof cast.properties !== 'object' || !cast.properties) {
    return ['cast.json: нужны schema_version 1, entities и properties.'];
  }
  const seen = new Set<string>();
  let worlds = 0;
  for (const entity of cast.entities) {
    const label = entity.name || entity.id || '(без имени)';
    if (!SLUG.test(entity.id)) problems.push(`Код сущности «${label}»: латиница в нижнем регистре, цифры и подчёркивание, начиная с буквы.`);
    if (seen.has(entity.id)) problems.push(`Код сущности повторяется: ${entity.id}.`);
    seen.add(entity.id);
    if (!SLUG.test(entity.kind)) problems.push(`${label}: тип должен быть кодом латиницей.`);
    if (!entity.name.trim()) problems.push(`Сущность ${entity.id}: нет названия.`);
    if (entity.kind === 'world') worlds += 1;
    for (const image of entity.images)
      if (!/^[a-z][a-z0-9_-]*\/[^/]+\.(png|jpe?g|webp)$/i.test(image)) problems.push(`${label}: путь изображения должен быть вида heroes/<файл>.png: ${image}`);
    for (const [key, value] of Object.entries(entity.initial_state)) {
      if (!SLUG.test(key)) problems.push(`${label}: свойство ${key} должно быть кодом латиницей.`);
      if (typeof value !== 'string' || !value.trim()) problems.push(`${label}: свойство ${key} пустое.`);
    }
  }
  if (worlds > 1) problems.push('Сущность типа world должна быть одна.');
  return problems;
}

export function readCast(project: string): CastFile | null | false {
  const path = join(project, 'plan', 'cast.json');
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as CastFile;
  } catch {
    return false;
  }
}

/** Добавляет словарь свойств для типов, у которых его нет: известным типам свой, остальным общий. */
export function ensureProperties(cast: CastFile, defaults: Defaults): CastFile {
  const properties = { ...cast.properties };
  for (const entity of cast.entities) {
    if (!properties[entity.kind]) properties[entity.kind] = JSON.parse(JSON.stringify(defaults.default[entity.kind] ?? defaults.generic)) as CastProperty[];
  }
  return { ...cast, properties };
}

/** Кастинг из референсов исходников; прежние правки сущностей сохраняются, world добавляется при отсутствии. */
export function castFromSources(manifest: SourceManifest, existing: CastFile | null, defaults: Defaults): CastFile {
  const cast: CastFile = existing
    ? JSON.parse(JSON.stringify(existing))
    : { schema_version: 1, entities: [JSON.parse(JSON.stringify(defaults.world))], properties: JSON.parse(JSON.stringify(defaults.default)) };
  const byId = new Map(cast.entities.map((e) => [e.id, e]));
  for (const ref of manifest.references) {
    const images = ref.files.map((f) => f.path);
    const entity = byId.get(ref.id);
    if (entity) {
      entity.images = images.length ? images : entity.images;
      if (!entity.appearance && ref.description) entity.appearance = ref.description;
      continue;
    }
    const kind = SLUG.test(ref.kind) && ref.kind !== WORLD_ID ? ref.kind : 'prop';
    const created: CastEntity = {
      id: ref.id,
      kind,
      name: ref.name,
      short_name: ref.short_name || ref.name,
      role: '',
      appearance: ref.description,
      images,
      initial_state: {}
    };
    cast.entities.push(created);
    byId.set(ref.id, created);
  }
  if (!cast.entities.some((e) => e.kind === 'world')) cast.entities.unshift(JSON.parse(JSON.stringify(defaults.world)));
  return ensureProperties(cast, defaults);
}

export function viewCast(project: string, toolsRoot: string | null): CastView {
  const problems: string[] = [];
  const manifest = readManifest(project);
  let cast = readCast(project);
  if (cast === false) {
    problems.push('plan/cast.json повреждён.');
    cast = null;
  }
  if (cast) {
    problems.push(...validateCast(cast));
    const current = ensureProperties(cast, loadDefaults(toolsRoot));
    cast = current;
    const known = new Set(manifest?.references.map((r) => r.id) ?? []);
    const fresh = [...known].filter((id) => !current.entities.some((e) => e.id === id));
    if (fresh.length) problems.push(`В исходниках есть референсы без сущности в кастинге: ${fresh.join(', ')}. Нажмите «Дополнить из исходников».`);
  }
  const imagePaths: Record<string, string> = {};
  for (const entity of cast?.entities ?? []) for (const image of entity.images) imagePaths[image] = join(project, 'source', image);
  for (const ref of manifest?.references ?? []) for (const file of ref.files) imagePaths[file.path] = join(project, 'source', file.path);
  return { cast, manifest, imagePaths, problems };
}

export function initCast(project: string, toolsRoot: string | null): CastFile {
  const manifest = readManifest(project);
  if (!manifest) throw new Error('Нет source/manifest.json: сначала загрузите исходники.');
  const existing = readCast(project);
  const cast = castFromSources(manifest, existing || null, loadDefaults(toolsRoot));
  return writeCast(project, cast, toolsRoot);
}

/** Чистая проверка перед trim/map: ответ агента и ручной JSON сначала остаются unknown. */
export function normalizeCast(value: unknown, toolsRoot: string | null): CastFile {
  const record = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null && !Array.isArray(v);
  const strings = (v: unknown): v is string[] => Array.isArray(v) && v.every((s) => typeof s === 'string');
  if (!record(value) || value.schema_version !== 1 || !Array.isArray(value.entities) || !record(value.properties))
    throw new Error('cast.json: нужны schema_version 1, entities и properties.');
  for (const entity of value.entities) {
    if (
      !record(entity) ||
      !['id', 'kind', 'name', 'short_name', 'role', 'appearance'].every((key) => typeof entity[key] === 'string') ||
      !strings(entity.images) ||
      !record(entity.initial_state) ||
      !Object.values(entity.initial_state).every((v) => typeof v === 'string')
    )
      throw new Error('cast.json: неверная структура сущности.');
  }
  for (const [kind, properties] of Object.entries(value.properties)) {
    if (
      !SLUG.test(kind) ||
      !Array.isArray(properties) ||
      !properties.every(
        (p) =>
          record(p) &&
          typeof p.key === 'string' &&
          SLUG.test(p.key) &&
          typeof p.label === 'string' &&
          (p.hint === undefined || typeof p.hint === 'string') &&
          (p.checklist === undefined || typeof p.checklist === 'string')
      )
    )
      throw new Error('cast.json: неверный словарь свойств.');
  }
  const cast = value as unknown as CastFile;
  const normalized = ensureProperties(
    {
      schema_version: 1,
      entities: cast.entities.map((e) => ({
        id: e.id.trim(),
        kind: e.kind.trim(),
        name: e.name.trim(),
        short_name: e.short_name.trim() || e.name.trim(),
        role: e.role.trim(),
        appearance: e.appearance.trim(),
        images: e.images,
        initial_state: Object.fromEntries(
          Object.entries(e.initial_state)
            .filter(([, v]) => typeof v === 'string' && v.trim())
            .map(([k, v]) => [k, v.trim()])
        )
      })),
      properties: cast.properties
    },
    loadDefaults(toolsRoot)
  );
  const problems = validateCast(normalized);
  if (problems.length) throw new Error(problems.join(' '));
  return normalized;
}

export function writeCast(project: string, cast: CastFile, toolsRoot: string | null): CastFile {
  const normalized = normalizeCast(cast, toolsRoot);
  for (const entity of normalized.entities)
    for (const image of entity.images) if (!existsSync(join(project, 'source', image))) throw new Error(`${entity.name}: нет файла source/${image}.`);
  mkdirSync(join(project, 'plan'), { recursive: true });
  writeFileSync(join(project, 'plan', 'cast.json'), JSON.stringify(normalized, null, 2) + '\n', 'utf-8');
  return normalized;
}

/** Карта references реестра сцен: сущности с изображениями, как в cast_registry.references. */
export function castReferences(cast: CastFile): Record<string, { name: string; path: string; short_name?: string }> {
  const result: Record<string, { name: string; path: string; short_name?: string }> = {};
  for (const entity of cast.entities) {
    if (!entity.images.length) continue;
    result[entity.id] = { name: entity.name, path: `source/${entity.images[0]}` };
    if (entity.short_name && entity.short_name !== entity.name) result[entity.id].short_name = entity.short_name;
  }
  return result;
}

export function initialStates(cast: CastFile | null): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  for (const entity of cast?.entities ?? []) if (Object.keys(entity.initial_state).length) result[entity.id] = { ...entity.initial_state };
  return result;
}
