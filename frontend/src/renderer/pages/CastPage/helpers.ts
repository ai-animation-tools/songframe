import { REFERENCE_VIEW_LABELS, type SourceManifest } from '@shared/types';
import type { CastImageOption } from './types';

/** Наибольшая длина начала заметки в подписи изображения, в символах. */
const NOTE_LABEL_MAX = 40;

/**
 * Начало заметки для подписи: первая фраза, не длиннее NOTE_LABEL_MAX символов и обрезанная по слову.
 * То же правило — sources.NoteLabel в Go: отчёт проверки сценария называет изображение так же.
 */
export function noteLabel(note: string | undefined): string {
  const first = (note ?? '')
    .trim()
    .split(/[.!?\n]/)[0]
    .trim();
  const chars = Array.from(first);
  if (chars.length <= NOTE_LABEL_MAX) return first;
  const cut = chars.slice(0, NOTE_LABEL_MAX).join('');
  const space = cut.lastIndexOf(' ');
  return (space > 0 ? cut.slice(0, space) : cut).replace(/[,;:—\- ]+$/, '').trim();
}

/**
 * Подписи изображений референса без путей: одно изображение — имя; несколько — «имя — вид»; при совпадении
 * вида — «имя — начало заметки»; оставшиеся совпадения получают номер файла в референсе. То же правило —
 * sources.FileLabels в Go: агент проверки сценария получает эти подписи. При изменении правятся оба места.
 */
export function referenceFileLabels(name: string, files: { view?: string | null; note?: string | null }[]): string[] {
  if (files.length === 1) return [name];
  const count = (labels: string[]) => labels.reduce((map, label) => map.set(label, (map.get(label) ?? 0) + 1), new Map<string, number>());
  let labels = files.map(
    (file) => `${name} — ${REFERENCE_VIEW_LABELS[(file.view ?? 'other') as keyof typeof REFERENCE_VIEW_LABELS] ?? REFERENCE_VIEW_LABELS.other}`
  );
  const byView = count(labels);
  labels = labels.map((label, index) => {
    const note = noteLabel(files[index].note ?? undefined);
    return byView.get(label)! > 1 && note ? `${name} — ${note}` : label;
  });
  const byNote = count(labels);
  return labels.map((label, index) => (byNote.get(label)! > 1 ? `${label} (${index + 1})` : label));
}

/** Изображения описи для привязки к сущности: подпись по referenceFileLabels, путь — для записи привязки. */
export function castImageOptions(manifest: SourceManifest | null): CastImageOption[] {
  return (manifest?.references ?? []).flatMap((reference) => {
    const labels = referenceFileLabels(reference.name.trim() || reference.id, reference.files);
    return reference.files.map((file, index) => ({ path: file.path, label: labels[index] }));
  });
}
