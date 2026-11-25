/** Черновик сборки из опор проверяется до записи: кадры смены и диапазоны параметров. */
import { describe, expect, it } from 'vitest';
import type { StaticShotView } from '@shared/types';
import { staticDraft, staticRecipe } from './useStaticShot';

const view: StaticShotView = {
  shot: 'M04',
  fps: 25,
  frames: 100,
  states: [
    { frame: 'K01', timeSeconds: 0, fromFrame: 0, dissolveFrames: 0, path: '/p/K01.png', approved: true },
    { frame: 'K02', timeSeconds: 1.6, fromFrame: 40, dissolveFrames: 0, path: '/p/K02.png', approved: true }
  ],
  params: { dilate: 14, push_in: 0.03 },
  specs: [
    { name: 'dilate', title: 'Расширение', min: 0, max: 64, default: 14, step: 1, hint: '' },
    { name: 'push_in', title: 'Наезд', min: 0, max: 0.3, default: 0.03, step: 0.005, hint: '' }
  ],
  problem: '',
  preview: null,
  saved: false,
  jobId: ''
};

describe('рецепт сборки из опор', () => {
  it('черновик по снимку даёт тот же рецепт', () => {
    expect(staticRecipe(view, staticDraft(view))).toEqual({
      schema_version: 1,
      states: [
        { frame: 'K01', from_frame: 0 },
        { frame: 'K02', from_frame: 40 }
      ],
      params: { dilate: 14, push_in: 0.03 }
    });
  });

  it('кадр смены — целое число позже предыдущего и раньше конца плана', () => {
    const draft = staticDraft(view);
    expect(staticRecipe(view, { ...draft, from: ['0', '2.5'] })).toBe('K02: кадр смены — целое число');
    expect(staticRecipe(view, { ...draft, from: ['0', '100'] })).toBe('K02: кадр смены должен быть позже предыдущего и раньше конца плана (100 кадров)');
    expect(staticRecipe(view, { ...draft, from: ['3', '40'] })).toBe('Базовая опора видна с первого кадра плана');
  });

  it('растворение — секунды в кадрах проекта, только у состояний, не дальше конца плана', () => {
    const draft = staticDraft(view);
    expect(draft.dissolve).toEqual(['0', '0']);
    expect(staticRecipe(view, { ...draft, dissolve: ['0', '1,5'] })).toMatchObject({
      states: [
        { frame: 'K01', from_frame: 0 },
        { frame: 'K02', from_frame: 40, dissolve_frames: 38 }
      ]
    });
    expect(staticRecipe(view, { ...draft, dissolve: ['0', '2.4'] })).toMatchObject({ states: [{}, { dissolve_frames: 60 }] });
    expect(staticRecipe(view, { ...draft, dissolve: ['0', '2.5'] })).toBe('K02: растворение должно закончиться не позже конца плана (100 кадров)');
    expect(staticRecipe(view, { ...draft, dissolve: ['0', '-1'] })).toBe('K02: растворение — число секунд не меньше 0');
    expect(staticDraft({ ...view, states: [view.states[0], { ...view.states[1], dissolveFrames: 30 }] }).dissolve).toEqual(['0', '1.2']);
  });

  it('параметр проверяется по диапазону и целому шагу', () => {
    const draft = staticDraft(view);
    expect(staticRecipe(view, { ...draft, params: { ...draft.params, dilate: '70' } })).toBe('«Расширение»: число от 0 до 64');
    expect(staticRecipe(view, { ...draft, params: { ...draft.params, dilate: '2.5' } })).toBe('«Расширение»: число от 0 до 64');
    expect(staticRecipe(view, { ...draft, params: { ...draft.params, push_in: '0.1' } })).not.toBeTypeOf('string');
  });
});
