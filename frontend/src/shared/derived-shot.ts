/** Рецепт локального монтажа не меняет постановку и не является запросом провайдеру генерации. */
import type { JobInfo } from './types';
import { derivedMainTexts as texts } from './texts/derived-shot-main';

export type DerivedShotRecipe =
  { mode: 'trim'; start_frame: number } | { mode: 'fit' | 'repeat'; start_frame: number; end_frame_exclusive: number } | { mode: 'still'; frame: number };

export interface DerivedShotPreview {
  id: string;
  videoPath: string;
  candidatePath: string;
  resultToken: string;
  recipe: DerivedShotRecipe;
  frames: number;
  fresh: boolean;
  problem: string | null;
  accepted: boolean;
}

export interface DerivedShotView {
  project: string;
  shot: string;
  title: string;
  action: string;
  sourceShot: string | null;
  sourceTitle: string;
  sourcePath: string | null;
  sourceFrames: number;
  targetFrames: number;
  recipe: DerivedShotRecipe | null;
  preview: DerivedShotPreview | null;
  job: JobInfo | null;
  problem: string | null;
  toolsProblem: string | null;
  hasAsset: boolean;
}

export interface DerivedShotApi {
  view(project: string, shot: string): Promise<DerivedShotView>;
  save(project: string, shot: string, recipe: DerivedShotRecipe): Promise<DerivedShotView>;
  build(project: string, shot: string, recipe: DerivedShotRecipe): Promise<DerivedShotView>;
  accept(project: string, shot: string, previewId: string, resultToken: string, replace: boolean): Promise<DerivedShotView>;
}

/** На границе IPC проверяем форму до доступа к полям; дробные кадры и лишние параметры не исполняются. */
export function checkedDerivedRecipe(value: unknown): DerivedShotRecipe {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(texts.recipeInvalid);
  const recipe = value as Record<string, unknown>;
  const keys = recipe.mode === 'trim' ? ['mode', 'start_frame'] : recipe.mode === 'still' ? ['frame', 'mode'] : ['end_frame_exclusive', 'mode', 'start_frame'];
  if (!['trim', 'fit', 'still', 'repeat'].includes(String(recipe.mode)) || Object.keys(recipe).sort().join('|') !== keys.sort().join('|'))
    throw new Error(texts.recipeInvalid);
  for (const key of keys.filter((key) => key !== 'mode'))
    if (typeof recipe[key] !== 'number' || !Number.isSafeInteger(recipe[key]) || Number(recipe[key]) < 0) throw new Error(texts.frameInvalid);
  if ((recipe.mode === 'fit' || recipe.mode === 'repeat') && Number(recipe.end_frame_exclusive) <= Number(recipe.start_frame))
    throw new Error(texts.intervalInvalid);
  return structuredClone(value) as DerivedShotRecipe;
}

/** Длина цели остаётся заданной сценарием; только явно выбранный режим определяет способ её заполнения. */
export function derivedRecipeProblem(recipe: DerivedShotRecipe, targetFrames: number, sourceFrames: number): string | null {
  try {
    checkedDerivedRecipe(recipe);
  } catch (error) {
    return error instanceof Error ? error.message : texts.recipeInvalid;
  }
  if (!Number.isSafeInteger(targetFrames) || targetFrames <= 0 || !Number.isSafeInteger(sourceFrames) || sourceFrames <= 0) return texts.framesUnavailable;
  if (recipe.mode === 'still') return recipe.frame < sourceFrames ? null : texts.sourceBounds;
  const end = recipe.mode === 'trim' ? recipe.start_frame + targetFrames : recipe.end_frame_exclusive;
  return end <= sourceFrames ? null : texts.sourceBounds;
}
