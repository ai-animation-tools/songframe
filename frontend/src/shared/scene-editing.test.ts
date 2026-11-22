import { describe, expect, it } from 'vitest';
import type { LyricsLine, SceneShot, TimingLine } from './types';
import { hasFillMarker, mergeShots, nextShotId, shotUnfilled, splitPlan, splitShot } from './scene-editing';

const shot = (id: string, start: number, end: number, extra: Partial<SceneShot> = {}): SceneShot => ({
  id,
  original: '',
  sequence: 'verse',
  start_frame: start,
  end_frame_exclusive: end,
  camera: '',
  action: '',
  continuity: '',
  references: ['—'],
  lipsync: false,
  card: { primary_reference: '—' },
  state_from: null,
  state_changes: {},
  ...extra
});

describe('объединение планов', () => {
  const list = [
    shot('M01', 0, 60, { action: 'Герой идёт', references: ['hero'], state_changes: { before: { hero: { position: 'у двери' } } } }),
    shot('M02', 60, 120, {
      original: 'Первая строка',
      camera: 'Средний план',
      action: 'Герой садится',
      continuity: 'Стык с M01',
      references: ['hero', 'chair'],
      state_from: 'M01',
      state_changes: { after: { hero: { posture: 'сидит' } } }
    }),
    shot('M03', 120, 200, {
      original: 'Вторая строка',
      camera: 'Крупный план',
      action: 'Герой смотрит в окно',
      notes: 'Свет из окна',
      references: ['hero', 'window'],
      lipsync: true,
      state_from: 'M02',
      state_changes: { before: { hero: { facing: 'к окну' } }, after: { hero: { posture: 'встал' } } }
    }),
    shot('M04', 200, 260, { state_from: { scene: 'M03', phase: 'before' }, derived_from: { shot: 'M03' } }),
    shot('M05', 260, 320, { state_from: 'M04' })
  ];

  it('сохраняет коды остальных планов и переводит ссылки на исчезнувшие коды к объединённому', () => {
    const result = mergeShots(list, 1, 1);
    expect(result.map((item) => item.id)).toEqual(['M01', 'M02', 'M04', 'M05']);
    expect(result[1]).toMatchObject({ start_frame: 60, end_frame_exclusive: 200, state_from: 'M01' });
    expect(result[2].state_from).toEqual({ scene: 'M02', phase: 'before' });
    expect(result[2].derived_from).toEqual({ shot: 'M02' });
    expect(result[3].state_from).toBe('M04');
  });

  it('склеивает постановку, объединяет референсы и сливает состояние по свойствам', () => {
    const merged = mergeShots(list, 1, 1)[1];
    expect(merged.original).toBe('Первая строка / Вторая строка');
    expect(merged.camera).toBe('ЗАПОЛНИТЬ: свести в одну постановку — Средний план / Крупный план');
    expect(merged.action).toBe('ЗАПОЛНИТЬ: свести в одну постановку — Герой садится / Герой смотрит в окно');
    expect(merged.continuity).toBe('Стык с M01');
    expect(shotUnfilled(merged)).toBe(true);
    expect(merged.notes).toBe('Свет из окна');
    expect(merged.references).toEqual(['hero', 'chair', 'window']);
    expect(merged.lipsync).toBe(true);
    expect(merged.state_changes).toEqual({ after: { hero: { posture: 'встал', facing: 'к окну' } } });
  });

  it('снимает у объединённого плана ссылку на собственный материал', () => {
    const derived = [shot('M01', 0, 60), shot('M02', 60, 120, { derived_from: { shot: 'M03' } }), shot('M03', 120, 180)];
    expect(mergeShots(derived, 1, 1)[1].derived_from).toBeUndefined();
  });

  it('оставляет статичный кадр, только если статичны все части и нет липсинка', () => {
    const still = (lipsync = false) => [shot('M01', 0, 60, { static_shot: true }), shot('M02', 60, 120, { static_shot: true, lipsync })];
    expect(mergeShots(still(), 0, 1)[0].static_shot).toBe(true);
    expect('static_shot' in mergeShots(still(true), 0, 1)[0]).toBe(false);
    const mixed = [shot('M01', 0, 60, { static_shot: true }), shot('M02', 60, 120)];
    expect('static_shot' in mergeShots(mixed, 0, 1)[0]).toBe(false);
  });
});

describe('пометка незаполненной постановки', () => {
  it('ищется в любом регистре, пустое поле постановки тоже незаполнено', () => {
    expect(hasFillMarker('сначала заполнить')).toBe(true);
    expect(hasFillMarker('Готово')).toBe(false);
    const filled = shot('M01', 0, 30, { camera: 'Статика', action: 'Идёт', continuity: 'Стык' });
    expect(shotUnfilled(filled)).toBe(false);
    expect(shotUnfilled({ ...filled, continuity: ' ' })).toBe(true);
  });

  it('деление помечает действие и непрерывность обеих половин, повторное объединение не вкладывает пометки', () => {
    const list = [shot('M04', 0, 100, { camera: 'Статика', action: 'Накрывает стол', continuity: 'Самовар на столе' }), shot('M05', 100, 160)];
    const { scenes } = splitShot(list, 0, { at: 50, byLine: false, first: '', second: '' });
    expect(scenes[0]).toMatchObject({ camera: 'Статика', action: 'ЗАПОЛНИТЬ: разделить между M04 и M04.1 — Накрывает стол' });
    expect(scenes[1].continuity).toBe('ЗАПОЛНИТЬ: разделить между M04 и M04.1 — Самовар на столе');
    const merged = mergeShots(scenes, 0, 1)[0];
    expect(merged).toMatchObject({ camera: 'Статика', action: 'Накрывает стол', continuity: 'Самовар на столе', end_frame_exclusive: 100 });
  });
});

describe('деление плана', () => {
  const lines: TimingLine[] = [
    { id: 1, source_line: 1, start: 2, end: 3.5 },
    { id: 2, source_line: 2, start: 3.6, end: 5 },
    { id: 3, source_line: 3, start: 5.2, end: 7.8 }
  ];
  const lyrics: LyricsLine[] = [
    { number: 1, text: 'Первая', header: false },
    { number: 2, text: 'Вторая', header: false },
    { number: 3, text: 'Третья', header: false }
  ];

  it('делит по началу строки песни, ближайшей к середине, и раздаёт строки половинам', () => {
    const target = shot('M07', 60, 240, { original: 'Первая / Вторая / Третья' });
    expect(splitPlan(target, lines, lyrics, 30)).toEqual({ at: 156, byLine: true, first: 'Первая / Вторая', second: 'Третья' });
  });

  it('без строк делит посередине и оставляет текст обеим половинам', () => {
    const target = shot('M07', 0, 100, { original: 'Инструментал' });
    expect(splitPlan(target, [], lyrics, 30)).toEqual({ at: 50, byLine: false, first: 'Инструментал', second: 'Инструментал' });
    expect(splitPlan(shot('M07', 0, 29), [], lyrics, 30)).toBeNull();
  });

  it('новая половина получает свободный код и продолжает итог первой, ссылки других планов не меняются', () => {
    const list = [
      shot('M07', 0, 100, { state_changes: { before: { hero: { position: 'у двери' } }, after: { hero: { position: 'у окна' } } } }),
      shot('M07.1', 100, 160),
      shot('M08', 160, 200, { state_from: 'M07' }),
      shot('M09', 200, 240, { state_from: { scene: 'M07', phase: 'same' } })
    ];
    const { scenes, id } = splitShot(list, 0, { at: 50, byLine: false, first: 'а', second: 'б' });
    expect(id).toBe('M07.2');
    expect(scenes.map((item) => item.id)).toEqual(['M07', 'M07.2', 'M07.1', 'M08', 'M09']);
    expect(scenes[0]).toMatchObject({ end_frame_exclusive: 50, original: 'а', state_changes: list[0].state_changes });
    expect(scenes[1]).toMatchObject({ start_frame: 50, original: 'б', state_from: 'M07', state_changes: {} });
    expect(scenes.slice(2)).toEqual(list.slice(1));
    expect(nextShotId(list, 'M07.1')).toBe('M07.2');
  });
});
