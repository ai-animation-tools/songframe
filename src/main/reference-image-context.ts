/** Чтение контекста для конструктора промпта не создаёт сессию и не запускает генератор. */
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, sep } from 'node:path';
import type { ReferenceImageContext, ReferenceImageContextDrafts } from '@shared/reference-image-generation';
import { referenceGenerationMessages as texts } from '@shared/texts/reference-images';
import { TEXT_LIMIT } from './agent-manager';
import { IDEA_NAME, LYRICS_NAME, MANIFEST_NAME, readManifest, SOURCE_DIR } from './sources';

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function text(value: unknown): string {
  if (typeof value !== 'string' || value.includes('\0')) throw new Error(texts.referenceContextInvalid);
  if (Buffer.byteLength(value) > TEXT_LIMIT) throw new Error(texts.referenceContextTooLarge);
  return value;
}
function read(path: string): string {
  if (statSync(path).size > TEXT_LIMIT) throw new Error(texts.referenceContextTooLarge);
  return text(readFileSync(path, 'utf8'));
}
function json(path: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(read(path));
  } catch (error) {
    if (error instanceof Error && error.message === texts.referenceContextTooLarge) throw error;
    throw new Error(texts.referenceContextInvalid, { cause: error });
  }
  if (!record(value)) throw new Error(texts.referenceContextInvalid);
  return value;
}

/** Отсутствующие до сценария файлы допустимы; повреждённый используемый источник не пропускается молча. */
export function readReferenceImageContext(project: string, drafts?: ReferenceImageContextDrafts): ReferenceImageContext {
  if (typeof project !== 'string' || !isAbsolute(project) || project.includes('\0')) throw new Error(texts.referenceContextInvalid);
  let canonical: string;
  try {
    canonical = realpathSync(project);
  } catch (error) {
    throw new Error(texts.referenceContextInvalid, { cause: error });
  }
  if (drafts !== undefined && !record(drafts)) throw new Error(texts.referenceContextInvalid);
  const projectData = json(join(canonical, 'plan/project.json'));
  const clipName = text(projectData.name);
  if (!clipName.trim()) throw new Error(texts.referenceContextInvalid);
  const source = join(canonical, SOURCE_DIR);
  const needsSaved = drafts?.idea === undefined || drafts?.lyrics === undefined;
  const manifest = needsSaved ? readManifest(canonical) : null;
  if (needsSaved && existsSync(join(source, MANIFEST_NAME)) && !manifest) throw new Error(texts.referenceContextInvalid);
  const saved = (field: 'idea' | 'lyrics', fallback: string): string => {
    const descriptor = manifest?.[field];
    if (descriptor !== undefined && descriptor !== null && (!record(descriptor) || typeof descriptor.path !== 'string' || !descriptor.path.trim()))
      throw new Error(texts.referenceContextInvalid);
    const name = descriptor?.path ?? fallback;
    const path = resolve(source, name);
    const local = relative(source, path);
    if (isAbsolute(name) || local === '..' || local.startsWith(`..${sep}`)) throw new Error(texts.referenceContextInvalid);
    if (!existsSync(path)) {
      if (descriptor) throw new Error(texts.referenceContextInvalid);
      return '';
    }
    try {
      return read(path);
    } catch (error) {
      if (error instanceof Error && error.message === texts.referenceContextTooLarge) throw error;
      throw new Error(texts.referenceContextInvalid, { cause: error });
    }
  };
  const idea = drafts?.idea !== undefined ? text(drafts.idea) : saved('idea', IDEA_NAME);
  const lyrics = drafts?.lyrics !== undefined ? text(drafts.lyrics) : saved('lyrics', LYRICS_NAME);
  const scenes = join(canonical, 'plan/scenes.json');
  const visualStyle = existsSync(scenes) ? text(json(scenes).visual_direction) : '';
  const context = { clipName, idea, lyrics, visualStyle };
  if (Buffer.byteLength(JSON.stringify(context)) > TEXT_LIMIT) throw new Error(texts.referenceContextTooLarge);
  return context;
}
