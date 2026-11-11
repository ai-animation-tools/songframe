/** Пересчёт границ переносит из каркаса только окна планов и строки песни, сохраняя постановку. */
import { describe, expect, it } from 'vitest';
import { scenarioTexts } from '@shared/texts/scenario';
import type { ScenesFile, SceneShot } from '@shared/types';
import { recalculateSceneBounds } from './sceneBounds';

const shot = (id: string, sequence: string, start: number, end: number, original: string): SceneShot => ({
  id,
  original,
  sequence,
  start_frame: start,
  end_frame_exclusive: end,
  camera: `Камера ${id}`,
  action: `Действие ${id}`,
  continuity: 'Свет слева.',
  references: ['hero'],
  lipsync: false,
  card: { primary_reference: 'hero' },
  state_from: null,
  state_changes: {}
});

const registry = (shots: SceneShot[], end = '12'): ScenesFile => ({
  schema_version: 1,
  fps: 30,
  audio: { path: 'source/track.mp3', end_seconds: end },
  references: { hero: { name: 'Герой', path: 'source/hero.png' } },
  visual_direction: 'Осень.',
  sequences: [
    { id: 'S01', title: 'Начало', direction: '' },
    { id: 'S02', title: 'Припев', direction: '' }
  ],
  scenes: shots
});

const current = registry([shot('M01', 'S01', 0, 90, 'Раз'), shot('M02', 'S01', 90, 180, 'Два'), shot('M03', 'S02', 180, 360, 'Три')]);

describe('recalculateSceneBounds', () => {
  it('сдвигает окна и строки песни, постановка остаётся', () => {
    const scaffold = registry([shot('M01', 'S01', 0, 105, 'Раз'), shot('M02', 'S01', 105, 180, 'Два и'), shot('M03', 'S02', 180, 360, 'Три')]);
    scaffold.scenes.forEach((item) => Object.assign(item, { camera: 'ЗАПОЛНИТЬ', action: 'ЗАПОЛНИТЬ' }));
    const result = recalculateSceneBounds(current, scaffold);
    if ('problem' in result) throw new Error(result.problem);
    expect(result.changed).toEqual(['M01', 'M02']);
    expect(result.scenes.scenes[0]).toEqual({ ...current.scenes[0], end_frame_exclusive: 105 });
    expect(result.scenes.scenes[1]).toEqual({ ...current.scenes[1], start_frame: 105, original: 'Два и' });
    expect(result.scenes.scenes[2]).toBe(current.scenes[2]);
  });

  it('без расхождений возвращает тот же реестр', () => {
    const result = recalculateSceneBounds(current, structuredClone(current));
    expect(result).toEqual({ scenes: current, changed: [] });
    if (!('problem' in result)) expect(result.scenes).toBe(current);
  });

  it('новая длительность трека переносится в audio', () => {
    const result = recalculateSceneBounds(current, registry(structuredClone(current.scenes), '12.5'));
    if ('problem' in result) throw new Error(result.problem);
    expect(result.scenes.audio.end_seconds).toBe('12.5');
    expect(result.changed).toEqual([]);
  });

  it('другое число планов в части объясняется, реестр не меняется', () => {
    const scaffold = registry([shot('M01', 'S01', 0, 180, 'Раз Два'), shot('M02', 'S02', 180, 270, 'Три'), shot('M03', 'S02', 270, 360, 'Три')]);
    expect(recalculateSceneBounds(current, scaffold)).toEqual({ problem: scenarioTexts.notice.boundsCountChanged({ part: 'Начало', was: 2, now: 1 }) });
  });

  it('другие части трактовки объясняются отдельно', () => {
    const scaffold = registry([shot('M01', 'S01', 0, 90, 'Раз'), shot('M02', 'S01', 90, 180, 'Два'), shot('M03', 'S03', 180, 360, 'Три')]);
    expect(recalculateSceneBounds(current, scaffold)).toEqual({ problem: scenarioTexts.notice.boundsPartsChanged });
  });
});
