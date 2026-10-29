/** Чистые операции над словарём свойств кастинга: проверка кода, порядок, очистка перед сохранением. */
import type { CastEntity, CastProperty } from '@shared/types';

/** Тот же формат кода, что проверяет главный процесс при сохранении cast.json. */
export const PROPERTY_KEY = /^[a-z][a-z0-9_]*$/;

/** Почему код свойства нельзя использовать; null — можно. Сравнение с кодами остальных свойств того же типа. */
export function propertyKeyProblem(key: string, otherKeys: readonly string[]): string | null {
  if (!key) return 'Введите код свойства.';
  if (!PROPERTY_KEY.test(key)) return 'Код начинается со строчной латинской буквы и содержит только a–z, цифры и «_».';
  return otherKeys.includes(key) ? `Свойство с кодом «${key}» уже есть в словаре этого типа.` : null;
}

export function propertyLabelProblem(label: string): string | null {
  return label.trim() ? null : 'Введите подпись: без неё поле состояния останется без названия.';
}

/** Перестановка элемента на offset позиций; за границами списка порядок не меняется. */
export function moveItem<T>(items: readonly T[], index: number, offset: number): T[] {
  const target = index + offset;
  if (index < 0 || index >= items.length || target < 0 || target >= items.length) return [...items];
  const next = [...items];
  const [item] = next.splice(index, 1);
  next.splice(target, 0, item);
  return next;
}

/** Варианты без пустых строк и повторов, в порядке ввода. */
export function propertyValues(values: readonly string[]): string[] {
  return [...new Set(values.map((value) => value.trim()).filter(Boolean))];
}

/**
 * Применяет правку с постоянным порядком полей и без пустых необязательных полей:
 * очищенное поле совпадает с сохранённым свойством без него, и признак правок не срабатывает зря.
 */
export function patchProperty(property: CastProperty, patch: Partial<CastProperty>): CastProperty {
  const merged = { ...property, ...patch };
  const result: CastProperty = { key: merged.key, label: merged.label };
  if (merged.hint) result.hint = merged.hint;
  if (merged.values?.length) result.values = merged.values;
  if (merged.checklist) result.checklist = merged.checklist;
  return result;
}

/** Словарь к сохранению: обрезанные пробелы, необязательные поля только при наличии значения. */
export function cleanProperties(properties: Record<string, CastProperty[]>): Record<string, CastProperty[]> {
  return Object.fromEntries(
    Object.entries(properties).map(([kind, list]) => [
      kind,
      list.map((property) =>
        patchProperty(
          { key: property.key.trim(), label: property.label.trim() },
          { hint: property.hint?.trim(), values: propertyValues(property.values ?? []), checklist: property.checklist?.trim() }
        )
      )
    ])
  );
}

/** Первая проблема словаря, мешающая сохранению; null — словарь можно сохранять. */
export function dictionaryProblem(properties: Record<string, CastProperty[]>, kindLabel: (kind: string) => string): string | null {
  for (const [kind, list] of Object.entries(properties)) {
    const where = `Словарь свойств, тип «${kindLabel(kind)}»`;
    for (const [index, property] of list.entries()) {
      const keyProblem = propertyKeyProblem(
        property.key,
        list.filter((_, other) => other !== index).map((p) => p.key)
      );
      if (keyProblem) return `${where}, свойство «${property.label.trim() || property.key || 'без кода'}»: ${keyProblem}`;
      if (propertyLabelProblem(property.label)) return `${where}: у свойства ${property.key} нет подписи. Введите её.`;
    }
  }
  return null;
}

/** Типы для словаря: сначала в порядке типов страницы, затем прочие из словаря и сущностей. */
export function dictionaryKinds(order: readonly string[], properties: Record<string, CastProperty[]>, entities: readonly CastEntity[]): string[] {
  const present = new Set([...Object.keys(properties), ...entities.map((entity) => entity.kind)]);
  return [...order.filter((kind) => present.has(kind)), ...[...present].filter((kind) => !order.includes(kind))];
}

/** Сколько сущностей типа уже хранят значение под кодом в начальном состоянии. */
export function propertyUsage(entities: readonly CastEntity[], kind: string, key: string): number {
  return entities.filter((entity) => entity.kind === kind && key in entity.initial_state).length;
}
