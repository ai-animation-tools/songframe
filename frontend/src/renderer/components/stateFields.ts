/** Каталог даёт метаданные, а строки формы — только состояние и локальный выбор пользователя. */
import type { CastProperty } from '@shared/types';

export function stateFieldRows(
  properties: CastProperty[],
  value: Record<string, string | null>,
  baseline: Record<string, string>,
  drafts: string[]
): CastProperty[] {
  const active = new Set([...Object.keys(value), ...Object.keys(baseline), ...drafts]);
  const known = new Set(properties.map((property) => property.key));
  return [
    ...properties.filter((property) => active.has(property.key)),
    ...[...active].filter((key) => !known.has(key)).map((key) => ({ key, label: key.replace(/_/g, ' ') }))
  ];
}

/** Удаление override возвращает наследование, null снимает значение из вычисленного состояния сцены. */
export function patchStateField(value: Record<string, string | null>, key: string, next: string | null | undefined): Record<string, string | null> {
  const copy = { ...value };
  if (next === undefined || next === '') delete copy[key];
  else copy[key] = next;
  return copy;
}
