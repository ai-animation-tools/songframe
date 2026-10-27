/** Экспорт копирует только завершённую пробу; исходники проекта не становятся местом сохранения. */
import { randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { copyFile, rename, rm } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, join, relative, resolve, sep } from 'node:path';

export function montageVideoPath(project: string, video: string): string {
  const path = resolve(project, video);
  const name = relative(resolve(project), path).split(sep).join('/');
  if (!/^plan\/batches\/review-manual-[\w-]+\/review\.mp4$/.test(name) || !existsSync(path))
    throw new Error('Готовая видеопроба не найдена. Дождитесь успешного экспорта.');
  const recipe = path.slice(0, -4) + '.json';
  let manifest: { video_sha256?: string; total_frames?: number };
  try {
    manifest = JSON.parse(readFileSync(recipe, 'utf8'));
  } catch {
    throw new Error('Экспорт ещё не завершён: нет рецепта готовой пробы.');
  }
  if (!manifest.video_sha256 || !(Number(manifest.total_frames) > 0)) throw new Error('Нет подтверждения успешной сборки пробы.');
  return path;
}

/** Временная копия рядом с назначением не оставляет обрезанный MP4 при ошибке копирования. */
export async function copyMontageVideo(project: string, video: string, destination: string): Promise<string> {
  const source = montageVideoPath(project, video);
  const target = resolve(extname(destination).toLowerCase() === '.mp4' ? destination : `${destination}.mp4`);
  const projectRoot = realpathSync(project);
  const actualTarget = existsSync(target) ? realpathSync(target) : join(realpathSync(dirname(target)), basename(target));
  const name = relative(projectRoot, actualTarget);
  const inside = name !== '..' && !name.startsWith(`..${sep}`) && !isAbsolute(name);
  if (inside && /^(source|assets|plan)(\/|\\|$)/.test(name))
    throw new Error('Выберите папку для показа результата вне source, assets и plan: здесь хранятся рабочие материалы проекта.');
  const temporary = `${target}.${randomUUID()}.tmp`;
  try {
    await copyFile(source, temporary);
    await rename(temporary, target);
  } finally {
    await rm(temporary, { force: true });
  }
  return target;
}
