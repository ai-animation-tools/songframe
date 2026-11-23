/** Свой план опор: роли и ID по порядку, границы запроса и понятные причины недоступности сохранения. */
import { describe, expect, it } from 'vitest';
import { productionTexts } from '@shared/texts/production';
import { addFrame, draftProblem, initialDraft, ownText, type OwnDescriptionDraft } from './ownDescription';

const texts = productionTexts.ownDescriptionDialog;
const draft = (frames: string[], seconds = '6'): OwnDescriptionDraft => ({
  description: 'Герой идёт к воротам.',
  requestSeconds: seconds,
  frames: frames.map((time) => ({ time, prompt: 'Кадр', referencePaths: [] }))
});

describe('своё описание плана', () => {
  it('начинает с двух опор, у речевого плана ручной генерации — с одной', () => {
    expect(initialDraft({ description: null, requestSeconds: null, framePrompts: [], window: 5.5, manual: false })).toMatchObject({
      requestSeconds: '6',
      frames: [{ time: '' }, { time: '' }]
    });
    expect(initialDraft({ description: '', requestSeconds: 7, framePrompts: [], window: 5.5, manual: true }).frames).toHaveLength(1);
  });

  it('выводит ID, роли и границы опор из порядка', () => {
    expect(ownText(draft(['', '2.5', '']))).toEqual({
      stage: 'description',
      description: 'Герой идёт к воротам.',
      requestSeconds: 6,
      keyframes: [
        { id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Кадр', referencePaths: [] },
        { id: 'K02', role: 'middle', timeSeconds: 2.5, prompt: 'Кадр', referencePaths: [] },
        { id: 'K03', role: 'last', timeSeconds: 6, prompt: 'Кадр', referencePaths: [] }
      ]
    });
    expect(ownText(draft([''])).keyframes).toEqual([{ id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Кадр', referencePaths: [] }]);
  });

  it('добавляет промежуточную опору перед последней, а к одной — конец', () => {
    expect(addFrame(draft(['', ''])).frames.map((frame) => frame.time)).toEqual(['', '3', '']);
    expect(addFrame(draft(['', '2', ''])).frames.map((frame) => frame.time)).toEqual(['', '2', '4', '']);
    expect(addFrame(draft([''])).frames).toHaveLength(2);
  });

  it('объясняет, что мешает сохранить', () => {
    expect(draftProblem({ ...draft(['', '']), description: ' ' }, 20)).toBe(texts.descriptionRequired);
    expect(draftProblem(draft(['', ''], '5.5'), 20)).toBe(texts.secondsInvalid);
    expect(draftProblem(draft(['', '', '']), 2)).toBe(texts.limit({ limit: 2 }));
    expect(draftProblem(draft(['', '7', '']), 20)).toBe(texts.frameTimeInvalid({ id: 'K02' }));
    expect(draftProblem(draft(['', '3', '2', '']), 20)).toBe(texts.frameTimeInvalid({ id: 'K03' }));
    expect(draftProblem({ ...draft(['', '']), frames: [{ time: '', prompt: '', referencePaths: [] }] }, 20)).toBeNull();
    expect(draftProblem(draft(['', '3', '']), 20)).toBeNull();
  });

  it('у плана из опор после K01 идут состояния внутри окна, конечной опоры нет', () => {
    const start = initialDraft({ description: 'Фары разгораются.', requestSeconds: null, framePrompts: [], window: 4.43, manual: false, staticShot: true });
    expect(start).toMatchObject({ requestSeconds: '5', frames: [{ time: '' }], staticShot: true, windowSeconds: 4.43 });
    // Новое состояние встаёт последним, посередине между предыдущим и концом окна.
    const two = addFrame(start);
    expect(two.frames.map((frame) => frame.time)).toEqual(['', '2.2']);
    expect(draftProblem(two, 20)).toBeNull();
    expect(ownText({ ...two, frames: [two.frames[0], { ...two.frames[1], time: '2.1' }] }).keyframes).toEqual([
      { id: 'K01', role: 'first', timeSeconds: 0, prompt: '', referencePaths: [] },
      { id: 'K02', role: 'middle', timeSeconds: 2.1, prompt: '', referencePaths: [] }
    ]);
    // Состояние не позже конца окна, даже если запрос длиннее.
    expect(draftProblem({ ...two, frames: [two.frames[0], { ...two.frames[1], time: '4.5' }] }, 20)).toBe(texts.stateTimeInvalid({ id: 'K02' }));
    expect(draftProblem({ ...two, frames: [two.frames[0], { ...two.frames[1], time: '' }] }, 20)).toBe(texts.stateTimeInvalid({ id: 'K02' }));
  });
});
