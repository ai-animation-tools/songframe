/** Имя папки и подсказка MP4 используют одинаковое преобразование названия клипа. */
export function slugify(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}
