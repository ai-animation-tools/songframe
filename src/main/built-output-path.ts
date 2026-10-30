/** Границы удаления готовых результатов: только обычные папки и файлы непосредственно в plan/batches. */
import { scenesTexts } from '@shared/texts/scenes';
import { lstatSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';

export function checkedBuiltOutput(project: string, path: string, kind: 'directory' | 'file'): string {
  if (typeof path !== 'string' || !isAbsolute(path)) throw new Error(scenesTexts.main.outputAbsolutePathRequired);
  const root = resolve(project);
  const target = resolve(path);
  const parts = relative(root, target).split(sep);
  if (parts.length !== (kind === 'directory' ? 3 : 4) || parts[0] !== 'plan' || parts[1] !== 'batches') throw new Error(scenesTexts.main.outputOutsideBatches);
  let current = root;
  for (const [index, part] of parts.entries()) {
    current = join(current, part);
    const stat = lstatSync(current, { throwIfNoEntry: false });
    // Проверяем каждый участок: ссылка на папку не должна выводить удаление к исходникам или в другой проект.
    if (!stat || stat.isSymbolicLink()) throw new Error(scenesTexts.main.outputMissingOrLink);
    if (index < parts.length - 1 || kind === 'directory') {
      if (!stat.isDirectory()) throw new Error(scenesTexts.main.outputDirectoryMissing);
    } else if (!stat.isFile()) throw new Error(scenesTexts.main.outputFileRequired);
  }
  return target;
}
