import { scenarioTexts } from '@shared/texts/scenario';
import { navigationTexts } from '@shared/texts/navigation';
/** Сравнение состояния на первом и последнем кадре плана: строки по сущностям с подписями и источниками значений. */
import type { BriefResult, CastFile, StateSource } from '@shared/types';

/** Как значение свойства меняется за план: как в diff, слева первый кадр, справа последний. */
export type BriefChange = 'same' | 'changed' | 'added' | 'removed';

export interface BriefCell {
  value: string;
  /** Где задано значение; null, если главный процесс не сообщил источник. */
  source: StateSource | null;
}

export interface BriefRow {
  key: string;
  label: string;
  before: BriefCell | null;
  after: BriefCell | null;
  change: BriefChange;
}

export interface BriefEntity {
  id: string;
  name: string;
  rows: BriefRow[];
  /** Сколько свойств сущности изменилось, появилось или снято за план. */
  changes: number;
}

// Мир сцены идёт первым, как в тексте врезки continuity_brief.
const WORLD_ID = 'world';

/** Подпись свойства из словаря кастинга; для свойства без подписи — код с пробелами вместо «_». */
export function propertyLabel(key: string, label?: string): string {
  return label?.trim() || key.replace(/_/g, ' ');
}

/** Короткая подпись источника значения: «Кастинг», «M57 · первый кадр», «M57 · итог». */
export function sourceLabel(source: StateSource): string {
  return source.kind === 'cast' ? navigationTexts.pages.cast : scenarioTexts.brief.planSource({ shot: source.shot, phase: source.phase });
}

function cell(brief: BriefResult, entity: string, key: string): BriefCell | null {
  const values = brief.state[entity];
  if (!values || !Object.hasOwn(values, key)) return null;
  return { value: values[key], source: brief.sources[entity]?.[key] ?? null };
}

function changeOf(before: BriefCell | null, after: BriefCell | null): BriefChange {
  if (!before) return 'added';
  if (!after) return 'removed';
  return before.value === after.value ? 'same' : 'changed';
}

/**
 * Строки сравнения по сущностям: сущности кастинга в его порядке (мир первым), затем неизвестные коды по алфавиту;
 * свойства — в порядке словаря типа, затем свои свойства в порядке появления.
 */
export function compareBrief(before: BriefResult, after: BriefResult, cast: CastFile | null): BriefEntity[] {
  const entities = cast?.entities ?? [];
  const present = (id: string): boolean => Boolean(before.state[id] || after.state[id]);
  const known = entities.map((entity) => entity.id).filter(present);
  known.sort((a, b) => Number(a !== WORLD_ID) - Number(b !== WORLD_ID));
  const unknown = [...new Set([...Object.keys(before.state), ...Object.keys(after.state)])].filter((id) => !entities.some((entity) => entity.id === id)).sort();

  return [...known, ...unknown].map((id) => {
    const entity = entities.find((item) => item.id === id);
    const properties = entity ? (cast?.properties[entity.kind] ?? []) : [];
    const first = before.state[id] ?? {};
    const last = after.state[id] ?? {};
    const used = (key: string): boolean => Object.hasOwn(first, key) || Object.hasOwn(last, key);
    const keys = [...new Set([...properties.map((property) => property.key).filter(used), ...Object.keys(first), ...Object.keys(last)])];
    const rows = keys.map((key): BriefRow => {
      const start = cell(before, id, key);
      const end = cell(after, id, key);
      return {
        key,
        // Подпись главного процесса учитывает и набор по умолчанию для типа без своего словаря.
        label: propertyLabel(key, after.labels?.[id]?.[key] ?? before.labels?.[id]?.[key] ?? properties.find((property) => property.key === key)?.label),
        before: start,
        after: end,
        change: changeOf(start, end)
      };
    });
    return { id, name: entity?.name.trim() || id, rows, changes: rows.filter((row) => row.change !== 'same').length };
  });
}

/** Всего изменений за план по всем сущностям. */
export function totalChanges(entities: BriefEntity[]): number {
  return entities.reduce((sum, entity) => sum + entity.changes, 0);
}

/** Пункт проверки кадра; phase указан, если пункт относится только к первому или только к последнему кадру. */
export interface BriefCheck {
  text: string;
  phase?: 'before' | 'after';
}

/** Один список «Что сверить» вместо двух: общие пункты один раз, пункты одной границы — с её отметкой. */
export function mergeChecklist(before: string[], after: string[]): BriefCheck[] {
  const items: BriefCheck[] = [...new Set(before)].map((text) => (after.includes(text) ? { text } : { text, phase: 'before' }));
  for (const text of new Set(after)) if (!before.includes(text)) items.push({ text, phase: 'after' });
  return items;
}
