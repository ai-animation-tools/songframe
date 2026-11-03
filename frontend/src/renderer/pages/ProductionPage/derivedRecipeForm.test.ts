import { describe, expect, it } from 'vitest';
import { draftRecipe, recipeDraft, recipeInfo, sameRecipe } from './derivedRecipeForm';

describe('кадровая форма производного плана', () => {
  it.each(['', '-1', '1.5', ' 1 ', 'NaN', '9007199254740992'])('не принимает нецелое или пустое поле %s', (start) => {
    expect(draftRecipe({ mode: 'trim', start, end: '', frame: '0' })).toBeNull();
  });
  it('сохраняет явный нулевой кадр и исключающую правую границу', () => {
    expect(draftRecipe({ mode: 'fit', start: '0', end: '45', frame: '0' })).toEqual({ mode: 'fit', start_frame: 0, end_frame_exclusive: 45 });
    expect(draftRecipe({ mode: 'repeat', start: '45', end: '45', frame: '0' })).toBeNull();
    expect(sameRecipe({ start_frame: 3, mode: 'trim' }, { mode: 'trim', start_frame: 3 })).toBe(true);
    expect(recipeDraft(null).mode).toBe('');
  });
  it('объясняет замедление, ускорение, частичный последний цикл и точное удержание', () => {
    expect(recipeInfo({ mode: 'fit', start_frame: 5, end_frame_exclusive: 35 }, 90)).toContain('скорость 0.333×. Движение будет замедлено');
    expect(recipeInfo({ mode: 'fit', start_frame: 5, end_frame_exclusive: 185 }, 90)).toContain('скорость 2.000×. Движение будет ускорено');
    expect(recipeInfo({ mode: 'repeat', start_frame: 5, end_frame_exclusive: 35 }, 95)).toContain('полных повторов 3, затем 5 кадров');
    expect(recipeInfo({ mode: 'still', frame: 10 }, 90)).toBe('Кадр 10 удерживается 90 кадров без движения.');
    expect(recipeInfo({ mode: 'trim', start_frame: 10 }, 90)).toContain('Кадры [10, 100)');
  });
});
