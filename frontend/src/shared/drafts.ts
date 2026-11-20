/**
 * Черновик несохранённых правок страницы во временном файле каталога состояния (`window.api.projects.*Draft`):
 * переживает падение или закрытие программы и не попадает в Git клипа. Go хранит содержимое как есть, формат
 * конверта принадлежит этому модулю.
 */

/** Страница черновика: «Схемы» (plan/schemes.json) или «Сценарий» (plan/scenes.json). */
export type DraftKind = 'schemes' | 'scenes';

/** Конверт черновика: когда записан, с какого сохранённого файла начаты правки и сам документ. */
export interface DraftEnvelope<T> {
  savedAt: string;
  /** JSON сохранённого документа, от которого начаты правки: другой файл на диске значит, что его поменяли после. */
  base: string;
  document: T;
}

/** Конверт для записи. */
export function draftEnvelope<T>(document: T, saved: unknown, now: Date = new Date()): string {
  const envelope: DraftEnvelope<T> = { savedAt: now.toISOString(), base: JSON.stringify(saved ?? null), document };
  return JSON.stringify(envelope);
}

/** Разбор записанного черновика; пустой, повреждённый или чужой формат — null. */
export function parseDraft<T>(content: string): DraftEnvelope<T> | null {
  if (!content) return null;
  try {
    const value = JSON.parse(content) as Partial<DraftEnvelope<T>> | null;
    if (!value || typeof value !== 'object' || typeof value.savedAt !== 'string' || typeof value.base !== 'string' || !('document' in value)) return null;
    return value as DraftEnvelope<T>;
  } catch {
    return null;
  }
}
