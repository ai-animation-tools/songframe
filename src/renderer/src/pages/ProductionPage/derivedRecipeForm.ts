import { checkedDerivedRecipe, derivedRecipeProblem, type DerivedShotRecipe, type DerivedShotView } from '@shared/derived-shot';
import { derivedShotTexts as texts } from '@shared/texts/derived-shot';

export interface DerivedRecipeDraft {
  mode: DerivedShotRecipe['mode'] | '';
  start: string;
  end: string;
  frame: string;
}

export function recipeDraft(recipe: DerivedShotRecipe | null): DerivedRecipeDraft {
  return {
    mode: recipe?.mode ?? '',
    start: recipe && 'start_frame' in recipe ? String(recipe.start_frame) : '0',
    end: recipe && 'end_frame_exclusive' in recipe ? String(recipe.end_frame_exclusive) : '',
    frame: recipe?.mode === 'still' ? String(recipe.frame) : '0'
  };
}

/** Пустое поле не превращается в нулевой кадр: пользователь должен задать все параметры выбранной операции. */
export function draftRecipe(draft: DerivedRecipeDraft): DerivedShotRecipe | null {
  const frame = (value: string): number => (/^\d+$/.test(value) ? Number(value) : NaN);
  try {
    if (!draft.mode) return null;
    return checkedDerivedRecipe(
      draft.mode === 'still'
        ? { mode: draft.mode, frame: frame(draft.frame) }
        : draft.mode === 'trim'
          ? { mode: draft.mode, start_frame: frame(draft.start) }
          : { mode: draft.mode, start_frame: frame(draft.start), end_frame_exclusive: frame(draft.end) }
    );
  } catch {
    return null;
  }
}

export function sameRecipe(left: DerivedShotRecipe | null, right: DerivedShotRecipe | null): boolean {
  return JSON.stringify(recipeDraft(left)) === JSON.stringify(recipeDraft(right));
}

export function recipeInfo(recipe: DerivedShotRecipe, frames: number): string {
  if (recipe.mode === 'still') return texts.stillInfo({ frame: recipe.frame, frames });
  if (recipe.mode === 'trim') return texts.trimInfo({ start: recipe.start_frame, end: recipe.start_frame + frames, frames });
  const length = recipe.end_frame_exclusive - recipe.start_frame;
  if (recipe.mode === 'repeat') return texts.repeatInfo({ length, cycles: Math.floor(frames / length), rest: frames % length, frames });
  return `${texts.fitInfo({ length, frames, speed: (length / frames).toFixed(3) })} ${length < frames ? texts.slowed : length > frames ? texts.accelerated : texts.sameSpeed}`;
}

/** Приёмка связана с показанным рецептом и кандидатом, а не только с наличием видео. */
export function derivedActionReasons(view: DerivedShotView, draft: DerivedRecipeDraft, busy: boolean) {
  const recipe = draftRecipe(draft);
  const dirty = JSON.stringify(draft) !== JSON.stringify(recipeDraft(view.recipe));
  const shapeProblem = !draft.mode ? texts.chooseModeReason : !recipe ? texts.invalidFrames : null;
  const boundsProblem = recipe ? derivedRecipeProblem(recipe, view.targetFrames, view.sourceFrames) : null;
  const build = busy ? texts.busy : (view.problem ?? view.toolsProblem ?? shapeProblem ?? boundsProblem);
  const preview = view.preview;
  const accept = busy
    ? texts.busy
    : (view.problem ??
      view.toolsProblem ??
      (dirty ? texts.saveFirst : null) ??
      (!preview ? texts.noPreview : preview.accepted ? texts.alreadyAccepted : (preview.problem ?? (!preview.fresh ? texts.stale : null))) ??
      (preview && !sameRecipe(recipe, preview.recipe) ? texts.previewDiffers : null));
  return { recipe, dirty, shapeProblem, boundsProblem, build, accept, save: busy ? texts.busy : (shapeProblem ?? (!dirty ? texts.noChanges : null)) };
}
