/** Пересчёт границ переносит из каркаса только окна планов и строки песни, сохраняя постановку. */
import { describe, expect, it } from 'vitest';
import { scenarioTexts } from '@shared/texts/scenario';
import type { ScenesFile, SceneShot, TimingLine, TreatmentFile } from '@shared/types';
import { recalculateSceneBounds, type SceneBoundsSource } from './sceneBounds';

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

const treatment = (maxShot?: number): TreatmentFile => ({
  schema_version: 1,
  logline: 'Клип.',
  sequences: [
    { id: 'S01', title: 'Начало', direction: '', start: 0, end: 6, entities: [], ...(maxShot ? { max_shot_seconds: maxShot } : {}) },
    { id: 'S02', title: 'Припев', direction: '', start: 6, end: 12, entities: [] }
  ]
});
const line = (source_line: number, start: number, end: number): TimingLine => ({ id: source_line, source_line, start, end });
const source = (lines: TimingLine[], maxShot?: number): SceneBoundsSource => ({ treatment: treatment(maxShot), lines, lyrics: [], duration: 12 });
const plain = source([line(1, 0.2, 2.9), line(2, 3, 5.9), line(3, 6.1, 11.8)]);

const current = registry([shot('M01', 'S01', 0, 90, 'Раз'), shot('M02', 'S01', 90, 180, 'Два'), shot('M03', 'S02', 180, 360, 'Три')]);

describe('recalculateSceneBounds', () => {
  it('сдвигает окна и строки песни, постановка остаётся', () => {
    const scaffold = registry([shot('M01', 'S01', 0, 105, 'Раз'), shot('M02', 'S01', 105, 180, 'Два и'), shot('M03', 'S02', 180, 360, 'Три')]);
    scaffold.scenes.forEach((item) => Object.assign(item, { camera: 'ЗАПОЛНИТЬ', action: 'ЗАПОЛНИТЬ' }));
    const result = recalculateSceneBounds(current, scaffold, plain);
    if ('problem' in result) throw new Error(result.problem);
    expect(result.changed).toEqual(['M01', 'M02']);
    expect(result.scenes.scenes[0]).toEqual({ ...current.scenes[0], end_frame_exclusive: 105 });
    expect(result.scenes.scenes[1]).toEqual({ ...current.scenes[1], start_frame: 105, original: 'Два и' });
    expect(result.scenes.scenes[2]).toBe(current.scenes[2]);
  });

  it('без расхождений возвращает тот же реестр', () => {
    const result = recalculateSceneBounds(current, structuredClone(current), plain);
    expect(result).toEqual({ scenes: current, changed: [] });
    if (!('problem' in result)) expect(result.scenes).toBe(current);
  });

  it('новая длительность трека переносится в audio', () => {
    const result = recalculateSceneBounds(current, registry(structuredClone(current.scenes), '12.5'), plain);
    if ('problem' in result) throw new Error(result.problem);
    expect(result.scenes.audio.end_seconds).toBe('12.5');
    expect(result.changed).toEqual([]);
  });

  // Каркас, где в «Припеве» стало два плана, а в «Начале» — один: состав разошёлся, причину ищут в первой такой части.
  const twoInChorus = registry([shot('M01', 'S01', 0, 180, 'Раз'), shot('M02', 'S02', 180, 300, 'Инструментал'), shot('M03', 'S02', 300, 360, 'Три')]);
  const notice = scenarioTexts.notice;
  const problem = (sourceData: SceneBoundsSource) => {
    const result = recalculateSceneBounds(current, twoInChorus, sourceData);
    if (!('problem' in result)) throw new Error('ожидался отказ');
    return result.problem;
  };

  it('строки части: каждая начинает свой план, совет — сверить границы со строками', () => {
    expect(problem(plain)).toBe(
      notice.boundsCountChanged({
        part: 'Начало',
        was: 2,
        now: 1,
        cause: notice.boundsCause.lines({ count: 2, first: 1, last: 2 }),
        fix: notice.boundsFix.lines
      })
    );
    expect(problem(plain)).toContain('в часть попадает 2 строки песни (строки 1–2)');
  });

  it('пауза перед первой строкой: отдельный план, совет — начало части к первой строке, сосед без строк удлинится', () => {
    // Первая строка «Начала» сдвинулась к 4.2: пауза 4.2 с от начала части стала отдельным планом.
    const text = problem(source([line(1, 4.2, 5.9), line(3, 6.1, 11.8)]));
    expect(text).toContain('пауза 4.2 с перед первой строкой (строка 1) стала отдельным планом');
    expect(text).toContain('сдвиньте начало части к 4.2 с');
    expect(text).not.toContain('станет длиннее');
  });

  it('пауза после последней строки: отдельный план, совет — конец части к концу строки, следующая часть без строк удлинится', () => {
    const text = problem(source([line(1, 0.2, 2.5)]));
    expect(text).toBe(
      notice.boundsCountChanged({
        part: 'Начало',
        was: 2,
        now: 1,
        cause: notice.boundsCause.trailPause({ seconds: '3.5', line: 1 }),
        // «Припев» без строк вырастет до 9.5 с и разделится на 2 плана вместо 1: совет сразу называет шаг 7 с.
        fix: notice.boundsFix.moveEnd({ at: '2.5' }) + notice.boundsFix.keepCount({ part: 'Припев', value: '7', count: 1 })
      })
    );
  });

  it('часть без строк делится по «Макс. план»', () => {
    expect(problem(source([line(3, 6.1, 11.8)], 3))).toBe(
      notice.boundsCountChanged({
        part: 'Начало',
        was: 2,
        now: 1,
        cause: notice.boundsCause.noLines({ length: '6', max: '3' }),
        fix: notice.boundsFix.maxShotValue({ value: '3', count: 2 })
      })
    );
  });

  it('без сохранённой трактовки причина не выдумывается, совет остаётся', () => {
    expect(problem({ treatment: null, lines: [], lyrics: [], duration: 12 })).toBe(
      notice.boundsCountChanged({ part: 'Начало', was: 2, now: 1, fix: notice.boundsFix.lines })
    );
  });

  it('строка, перешедшая в соседнюю часть, — отказ даже при том же числе планов', () => {
    // Строка 2 «Два» сдвинулась к 5.5–7.0: середина 6.25 уже в «Припеве», а граница частей осталась на 6.
    const lyrics = ['Раз', 'Два', 'Три'].map((text, index) => ({ number: index + 1, text, header: false }));
    const moved = { ...source([line(1, 0.2, 2.9), line(2, 5.5, 7), line(3, 7.1, 11.8)]), lyrics };
    const scaffold = registry([
      shot('M01', 'S01', 0, 90, 'Раз'),
      shot('M02', 'S01', 90, 180, 'Инструментал: Начало'),
      shot('M03', 'S02', 180, 360, 'Два / Три')
    ]);
    expect(recalculateSceneBounds(current, scaffold, moved)).toEqual({
      problem: notice.boundsLineMoved({
        line: 2,
        text: 'Два',
        start: '5.5',
        end: '7',
        to: 'Припев',
        from: 'Начало',
        fix: notice.boundsFix.movePartEnd({ part: 'Начало', at: '7' })
      })
    });
    // Строка ушла в более раннюю часть: совет — начало её прежней части к началу строки.
    const earlier = registry([
      shot('M01', 'S01', 0, 90, 'Раз'),
      shot('M02', 'S01', 90, 180, 'Два / Три'),
      shot('M03', 'S02', 180, 360, 'Инструментал: Припев')
    ]);
    const early = { ...source([line(1, 0.2, 2.9), line(2, 3, 5.9), line(3, 5.2, 6.5)]), lyrics };
    expect(recalculateSceneBounds(current, earlier, early)).toEqual({
      problem: notice.boundsLineMoved({
        line: 3,
        text: 'Три',
        start: '5.2',
        end: '6.5',
        to: 'Начало',
        from: 'Припев',
        fix: notice.boundsFix.movePartStart({ part: 'Припев', at: '5.2' })
      })
    });
    // Строка ушла в часть без других строк: после совета та сожмётся до 4.8 с и при шаге 6 с дала бы 1 план вместо 2,
    // поэтому совет сразу называет её «Макс. план, с».
    const instrumental = registry([
      shot('M01', 'S01', 0, 90, 'Инструментал: Начало'),
      shot('M02', 'S01', 90, 180, 'Инструментал: Начало'),
      shot('M03', 'S02', 180, 360, 'Два')
    ]);
    const intoIntro = registry([
      shot('M01', 'S01', 0, 90, 'Инструментал: Начало'),
      shot('M02', 'S01', 90, 180, 'Два'),
      shot('M03', 'S02', 180, 360, 'Инструментал: Припев')
    ]);
    expect(recalculateSceneBounds(instrumental, intoIntro, { ...source([line(2, 4.8, 7)]), lyrics })).toEqual({
      problem: notice.boundsLineMoved({
        line: 2,
        text: 'Два',
        start: '4.8',
        end: '7',
        to: 'Начало',
        from: 'Припев',
        fix: notice.boundsFix.movePartStart({ part: 'Припев', at: '4.8' }) + notice.boundsFix.keepCount({ part: 'Начало', value: '2', count: 2 })
      })
    });
    // Подпись плана без строк песни и повторы текста в той же части проверку не задевают.
    expect('problem' in recalculateSceneBounds(current, structuredClone(current), { ...plain, lyrics })).toBe(false);
  });

  it('другие части трактовки объясняются отдельно', () => {
    const scaffold = registry([shot('M01', 'S01', 0, 90, 'Раз'), shot('M02', 'S01', 90, 180, 'Два'), shot('M03', 'S03', 180, 360, 'Три')]);
    expect(recalculateSceneBounds(current, scaffold, plain)).toEqual({ problem: scenarioTexts.notice.boundsPartsChanged });
  });
});
