import { describe, expect, it } from 'vitest';
import type { LyricsLine, TimingLine } from '@shared/types';
import { buildSections } from '@shared/timing-sections';
import {
  canVerifyEditorLine,
  collectEditorLines,
  editorLineOrder,
  editorSectionLayout,
  editorTimingRows,
  moveEditorLine,
  stableTimingLines,
  visibleEditorRows
} from './timingEditor';

const lyrics: LyricsLine[] = [
  { number: 1, text: '[Куплет]', header: true },
  { number: 2, text: 'Начало', header: false },
  { number: 3, text: 'Припев', header: false },
  { number: 4, text: '', header: false },
  { number: 5, text: 'Припев', header: false }
];

describe('редактор исходных строк', () => {
  it('разрешает подтверждение только конечного интервала длиной от 0,3 с', () => {
    const line = { id: 2, source_line: 2, start: 0, end: 0.3 };
    expect(canVerifyEditorLine(line)).toBe(true);
    expect(canVerifyEditorLine({ ...line, start: 2, end: 2.3 })).toBe(true);
    expect(canVerifyEditorLine({ ...line, start: 2, end: 2.299 })).toBe(false);
    expect(canVerifyEditorLine({ ...line, end: 0.29 })).toBe(false);
    expect(canVerifyEditorLine({ ...line, start: Number.NaN, end: Number.NaN })).toBe(false);
    expect(canVerifyEditorLine({ ...line, start: 4, end: 2 })).toBe(false);
    expect(canVerifyEditorLine({ ...line, end: Infinity })).toBe(false);
  });

  it('сохраняет пропущенную середину и различает одинаковые припевы по физическому номеру', () => {
    const lines = stableTimingLines([{ id: 1, source_line: 5, start: 4, end: 6, verified: true }]);
    const rows = editorTimingRows(lyrics, lines, [], []);
    expect(rows.map((line) => line.id)).toEqual([2, 3, 5]);
    expect(rows[0].start).toBeNaN();
    expect(rows[1].end).toBeNaN();
    expect(rows[2]).toMatchObject({ id: 5, source_line: 5, start: 4, verified: true });
    expect(visibleEditorRows(rows, 'remaining').map((line) => line.source_line)).toEqual([2, 3]);
    expect(visibleEditorRows(rows, 'verified').map((line) => line.source_line)).toEqual([5]);
  });

  it('показывает кандидата с его границами, не добавляя его к принятой разметке', () => {
    const canonical = [{ id: 2, source_line: 2, start: 0, end: 4 }];
    const candidates = [{ source_line: 3, start: 1, end: 5, reason: 'низкая оценка', acoustic_score: 0.3, note: 'Проверить тихий вход' }];
    const rows = editorTimingRows(lyrics, canonical, candidates, []);
    expect(rows[1]).toMatchObject({ id: 3, start: 1, end: 5, verified: false, note: 'Проверить тихий вход' });
    expect(collectEditorLines(canonical, {}).lines).toEqual(canonical);
    expect(candidates).toHaveLength(1);
  });

  it('сохраняет порядок редактора без изменения времён и отбрасывает устаревшие номера', () => {
    const order = editorLineOrder(lyrics, [5, 5, 100, 2]);
    expect(order).toEqual([5, 2, 3]);
    expect(moveEditorLine(order, 3, 5)).toEqual([3, 5, 2]);
    expect(moveEditorLine([2, 3, 5], 2, 3)).toEqual([3, 2, 5]);
    expect(moveEditorLine(order, 100, 2)).toBe(order);
    expect(editorLineOrder(lyrics)).toEqual([2, 3, 5]);
  });

  it('не теряет заметку строки при полностью пустых границах', () => {
    const line = { id: 3, source_line: 3, start: Number.NaN, end: Number.NaN, note: 'Не потерять тихий вход' };
    const collected = collectEditorLines([line], { 3: { start: '', end: '' } });
    expect(collected.lines).toEqual([line]);
    expect(collected.problems).toEqual(['Строка текста 3: заполните начало и конец либо очистите оба поля.']);
    expect(line.note).toBe('Не потерять тихий вход');
  });

  it('пропускает полностью пустую строку, но оставляет частичный и нечисловой ввод для исправления', () => {
    const rows = editorTimingRows(lyrics, [], [], []);
    const drafts = { 2: { start: '', end: '' }, 3: { start: 'не время', end: '8' }, 5: { start: '-2', end: '' } };
    const collected = collectEditorLines(rows, drafts);
    expect(collected.lines.map((line) => line.source_line)).toEqual([3, 5]);
    expect(collected.problems).toEqual(['Строка текста 3: границы должны быть числами.', 'Строка текста 5: заполните начало и конец либо очистите оба поля.']);
    expect(drafts[3].start).toBe('не время');
    expect(drafts[5].start).toBe('-2');
  });
});

describe('editorSectionLayout', () => {
  const song: LyricsLine[] = [
    { number: 1, text: '[Куплет 1]', header: true },
    { number: 2, text: 'Первая', header: false },
    { number: 3, text: '[Припев]', header: true },
    { number: 4, text: 'Вторая', header: false },
    { number: 5, text: '[Припев]', header: true },
    { number: 6, text: 'Третья', header: false }
  ];
  const timed = (source_line: number, start: number, end: number): TimingLine => ({ id: source_line, source_line, start, end, verified: true });

  it('показывает все секции карты с границами, имена частей — без скобок', () => {
    const rows = [timed(2, 5, 10), timed(4, 10, 15), timed(6, 25, 30)];
    const layout = editorSectionLayout(song, buildSections(song, rows, 40), rows, rows);
    const names = (id: number) => layout.before.get(id)?.map((header) => [header.name, header.start, header.end, header.gap]);
    expect(names(2)).toEqual([
      ['Вступление', 0, 5, true],
      ['Куплет 1', 5, 10, false]
    ]);
    expect(names(4)).toEqual([['Припев', 10, 15, false]]);
    // Одинаковые припевы получают свои границы по перекрытию строк, проигрыш встаёт перед вторым.
    expect(names(6)).toEqual([
      ['Проигрыш после «Припев»', 15, 25, true],
      ['Припев', 25, 30, false]
    ]);
    expect(layout.after.map((header) => [header.name, header.start, header.end, header.note])).toEqual([['Финал без вокала', 30, 40, 'до конца трека']]);
  });

  it('границы следуют за правкой строки, а часть без разметки остаётся с названием', () => {
    const rows = [timed(2, 0, 8), { id: 4, source_line: 4, start: Number.NaN, end: Number.NaN, verified: false }, timed(6, 8, 12)];
    const layout = editorSectionLayout(
      song,
      buildSections(
        song,
        rows.filter((row) => Number.isFinite(row.start)),
        12
      ),
      rows,
      rows
    );
    expect(layout.before.get(2)?.map((header) => [header.name, header.end])).toEqual([['Куплет 1', 8]]);
    expect(layout.before.get(4)).toEqual([{ key: 'part:1', name: 'Припев', gap: false }]);
    expect(layout.before.get(6)?.map((header) => [header.name, header.start, header.end])).toEqual([['Припев', 8, 12]]);
    expect(layout.after).toEqual([]);
  });
});
