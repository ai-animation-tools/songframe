import { describe, expect, it } from 'vitest';
import type { SceneShot } from './types';
import { renumberShots } from './scene-editing';

describe('перенумерация при объединении планов', () => {
  it('сохраняет наследование удалённого плана без самоссылки и поддерживает явную фазу', () => {
    const list = [
      { id: 'M01', state_from: null },
      { id: 'M03', state_from: 'M02' },
      { id: 'M04', state_from: { scene: 'M02', phase: 'before' } }
    ] as SceneShot[];
    const result = renumberShots(list, new Map([['M02', 'M01']]));
    expect(result.map((shot) => [shot.id, shot.state_from])).toEqual([
      ['M01', null],
      ['M02', 'M01'],
      ['M03', { scene: 'M01', phase: 'before' }]
    ]);
    expect(list[1].state_from).toBe('M02');
  });
  it('переносит ссылки при делении, сохраняя внешние источники', () => {
    const list = [
      { id: 'M01', state_from: null },
      { id: 'M01.1', state_from: 'M01' },
      { id: 'M02', state_from: 'M01.1' }
    ] as SceneShot[];
    expect(renumberShots(list).map((shot) => [shot.id, shot.state_from])).toEqual([
      ['M01', null],
      ['M02', 'M01'],
      ['M03', 'M02']
    ]);
  });
});
