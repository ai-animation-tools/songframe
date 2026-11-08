/** Сравнение врезки показывает, что изменилось за план и где задано каждое значение. */
import { describe, expect, it } from 'vitest';
import type { BriefResult, CastFile } from '@shared/types';
import { compareBrief, mergeChecklist, propertyLabel, sourceLabel, totalChanges } from './briefComparison';

const cast = {
  schema_version: 1,
  entities: [
    { id: 'oleg', kind: 'hero', name: 'Олег', short_name: '', role: '', appearance: '', images: [], initial_state: {} },
    { id: 'world', kind: 'world', name: 'Мир сцены', short_name: '', role: '', appearance: '', images: [], initial_state: {} },
    { id: 'car', kind: 'vehicle', name: '', short_name: '', role: '', appearance: '', images: [], initial_state: {} }
  ],
  properties: {
    hero: [
      { key: 'pose', label: 'Поза' },
      { key: 'hands', label: 'Руки' }
    ],
    world: [{ key: 'time_of_day', label: 'Время суток' }]
  }
} as CastFile;

function brief(phase: 'before' | 'after', state: BriefResult['state'], sources: BriefResult['sources'], labels: BriefResult['labels'] = {}): BriefResult {
  return { shot: 'M58', phase, state, sources, labels, inherited: {}, paragraph: '', checklist: [], text: '' };
}

const before = brief(
  'before',
  { oleg: { hands: 'на руле', pose: 'сидит', scar: 'есть' }, world: { time_of_day: 'ночь' } },
  {
    oleg: { hands: { kind: 'cast' }, pose: { kind: 'plan', shot: 'M57', phase: 'after' }, scar: { kind: 'cast' } },
    world: { time_of_day: { kind: 'cast' } }
  }
);
const after = brief(
  'after',
  { oleg: { hands: 'на руле', pose: 'стоит', helmet_on: 'да' }, world: { time_of_day: 'ночь' }, ghost: { mood: 'тихо' } },
  {
    oleg: { hands: { kind: 'cast' }, pose: { kind: 'plan', shot: 'M58', phase: 'after' }, helmet_on: { kind: 'plan', shot: 'M58', phase: 'after' } },
    world: { time_of_day: { kind: 'cast' } },
    ghost: { mood: { kind: 'plan', shot: 'M58', phase: 'before' } }
  }
);

describe('compareBrief', () => {
  const entities = compareBrief(before, after, cast);

  it('ставит мир первым, затем сущности кастинга и неизвестные коды', () => {
    expect(entities.map((entity) => entity.id)).toEqual(['world', 'oleg', 'ghost']);
    expect(entities.map((entity) => entity.name)).toEqual(['Мир сцены', 'Олег', 'ghost']);
  });

  it('упорядочивает свойства по словарю и подписывает их', () => {
    const oleg = entities[1];
    expect(oleg.rows.map((row) => row.key)).toEqual(['pose', 'hands', 'scar', 'helmet_on']);
    expect(oleg.rows.map((row) => row.label)).toEqual(['Поза', 'Руки', 'scar', 'helmet on']);
  });

  it('различает изменённые, добавленные, снятые и прежние значения', () => {
    const oleg = entities[1];
    expect(oleg.rows.map((row) => row.change)).toEqual(['changed', 'same', 'removed', 'added']);
    expect(oleg.rows[2].after).toBeNull();
    expect(oleg.rows[3].before).toBeNull();
    expect(oleg.changes).toBe(3);
    expect(entities[0].changes).toBe(0);
    expect(totalChanges(entities)).toBe(4);
  });

  it('несёт источник каждого значения', () => {
    const pose = entities[1].rows[0];
    expect(pose.before).toEqual({ value: 'сидит', source: { kind: 'plan', shot: 'M57', phase: 'after' } });
    expect(pose.after).toEqual({ value: 'стоит', source: { kind: 'plan', shot: 'M58', phase: 'after' } });
  });

  it('без кастинга и источников остаётся работоспособным', () => {
    const result = compareBrief(brief('before', { b: { x_y: '1' } }, {}), brief('after', { a: { x_y: '1' } }, {}), null);
    expect(result.map((entity) => entity.id)).toEqual(['a', 'b']);
    expect(result[1].rows[0]).toEqual({ key: 'x_y', label: 'x y', before: { value: '1', source: null }, after: null, change: 'removed' });
  });
});

describe('подписи', () => {
  it('подпись свойства без словаря — код с пробелами', () => {
    expect(propertyLabel('time_of_day')).toBe('time of day');
    expect(propertyLabel('time_of_day', ' Время ')).toBe('Время');
  });

  it('источник называет кастинг или план с фазой', () => {
    expect(sourceLabel({ kind: 'cast' })).toBe('Кастинг');
    expect(sourceLabel({ kind: 'plan', shot: 'M59', phase: 'before' })).toBe('M59 · первый кадр');
    expect(sourceLabel({ kind: 'plan', shot: 'M57', phase: 'after' })).toBe('M57 · итог');
  });
});

describe('mergeChecklist', () => {
  it('показывает общий пункт один раз и отмечает пункты одной границы', () => {
    expect(mergeChecklist(['Олег: сидит?', 'Ночь?', 'Ночь?'], ['Олег: стоит?', 'Ночь?'])).toEqual([
      { text: 'Олег: сидит?', phase: 'before' },
      { text: 'Ночь?' },
      { text: 'Олег: стоит?', phase: 'after' }
    ]);
    expect(mergeChecklist([], [])).toEqual([]);
  });

  it('берёт подпись свойства из врезки главного процесса: она учитывает набор по умолчанию', () => {
    const start = brief('before', { oleg: { scar: 'есть' } }, { oleg: { scar: { kind: 'cast' } } }, { oleg: { scar: 'Шрам' } });
    const end = brief('after', { oleg: { scar: 'есть' } }, { oleg: { scar: { kind: 'cast' } } }, { oleg: { scar: 'Шрам' } });
    expect(compareBrief(start, end, cast)[0].rows.find((row) => row.key === 'scar')?.label).toBe('Шрам');
  });
});
