/** Границы удаления готовых результатов: только обычные папки и файлы непосредственно в plan/batches. */
import { lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function checkedBuiltOutput(project: string, path: string, kind: 'directory' | 'file'): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error('Укажите абсолютный путь собранного результата.');
  const root = resolve(project);
  const target = resolve(path);
  const parts = relative(root, target).split(sep);
  if (parts.length !== (kind === 'directory' ? 3 : 4) || parts[0] !== 'plan' || parts[1] !== 'batches')
    throw new Error('Удалять можно только собранные результаты внутри plan/batches выбранного проекта.');
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    // Проверяем каждый участок: ссылка на папку не должна выводить удаление к исходникам или в другой проект.
    if (!stat || stat.isSymbolicLink()) throw new Error('Результат отсутствует или путь содержит символическую ссылку. Обновите список.');
    if (index < parts.length - 1 || kind === 'directory') {
      if (!stat.isDirectory()) throw new Error('Папка собранного результата отсутствует. Обновите список.');
    } else if (!stat.isFile()) throw new Error('Собранный результат должен быть обычным файлом.');
  }
  return target;
}
