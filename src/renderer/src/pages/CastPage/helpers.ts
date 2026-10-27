import { REFERENCE_VIEW_LABELS, type SourceManifest } from '@shared/types';
import type { CastImageOption } from './types';

/** Вид различает изображения одного референса; путь сохраняется для записи привязки. */
export function castImageOptions(manifest: SourceManifest | null): CastImageOption[] {
  const options = (manifest?.references ?? []).flatMap((reference) =>
    reference.files.map((file) => ({
      path: file.path,
      label: [reference.name.trim() || reference.id, reference.files.length > 1 ? REFERENCE_VIEW_LABELS[file.view] : ''].filter(Boolean).join(' — ')
    }))
  );
  // При совпадении названия и вида путь позволяет выбрать нужное изображение.
  const counts = new Map<string, number>();
  for (const option of options) counts.set(option.label, (counts.get(option.label) ?? 0) + 1);
  return options.map((option) => (counts.get(option.label)! > 1 ? { ...option, label: `${option.label} (${option.path})` } : option));
}
