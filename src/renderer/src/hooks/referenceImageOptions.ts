import { REFERENCE_VIEW_LABELS, type ReferenceView } from '@shared/types';
import type { ReferenceImageOption } from '@shared/reference-image-generation';

/** Обе страницы передают примечание отдельно: нейтральная подпись не подмешивает его в новый запрос. */
export function referenceImageOption(input: { path: string; view?: ReferenceView; note?: string }): ReferenceImageOption {
  const note = input.note?.trim();
  return { path: input.path, label: REFERENCE_VIEW_LABELS[input.view ?? 'other'], ...(note ? { note } : {}) };
}
