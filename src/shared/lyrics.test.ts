/** Формат одинаков для ручного ввода и текста, прочитанного из файла. */
import { describe, expect, it } from 'vitest';
import { analyzeLyrics, selectLyricTimings } from './lyrics';

const song = '[Куплет 1]\nПервая строка\nВторая строка\n\n[Припев]\nПоём вместе\n[Припев]\nПоём вместе';

describe('формат текста песни', () => {
  it('различает слова, повторяющиеся секции и пустые строки, сохраняя номера файла', () => {
    const parsed = analyzeLyrics(song);
    expect(parsed.problems).toEqual([]);
    expect(parsed.sections).toEqual(['Куплет 1', 'Припев', 'Припев']);
    expect(analyzeLyrics('[Соло гитары]\n[Разговор у костра]\nСлова\n[Outro 2]').sections).toEqual(['Соло гитары', 'Разговор у костра', 'Outro 2']);
    expect(parsed.rows.filter((row) => row.text && !row.header).map((row) => row.number)).toEqual([2, 3, 6, 8]);
    expect(parsed.lines).toBe(4);
  });

  it('принимает BOM, CRLF и заголовки без пустых строк между секциями', () => {
    const parsed = analyzeLyrics('\ufeff [ Куплет 1 ]\r\nСтрока\r\n[Припев]\r\nЕщё строка');
    expect(parsed.problems).toEqual([]);
    expect(parsed.sections).toEqual(['Куплет 1', 'Припев']);
    expect(parsed.lines).toBe(2);
  });

  it.each(['[Припев', 'Припев]', '[]', '[ ]', '[Припев] слова', '[[Припев]]', '# Припев', '- строка', '1. строка', 'Припев:'])(
    'объясняет ошибку строки и не предлагает её как слова песни: %s',
    (bad) => {
      const parsed = analyzeLyrics(`Верная строка\n${bad}`);
      expect(parsed.problems.join(' ')).toMatch(/(?:Строка|строки) 2/);
      expect(parsed.rows[1].header).toBe(true);
      expect(parsed.lines).toBe(1);
    }
  );

  it('не требует секций у песни и не путает упоминание припева со служебным названием', () => {
    expect(analyzeLyrics('Обычная строка\nПрипев этот мы поём вчетвером').problems).toEqual([]);
    expect(analyzeLyrics('[Припев]').problems.join(' ')).toContain('нет ни одной строки');
  });

  it('исключает старые тайминги заголовков и удалённых строк без изменения входного массива', () => {
    const lines = [2, 5, 99].map((source_line, i) => ({ id: i + 1, source_line, start: i, end: i + 1, verified: false, note: '' }));
    const selected = selectLyricTimings(lines, analyzeLyrics(song).rows);
    expect(selected.lines).toEqual([lines[0]]);
    expect(selected.invalidIds).toEqual([2, 3]);
    expect(lines).toHaveLength(3);
  });
});

/** Проверяем фразы через анализатор: синтаксис и физические номера строк остаются владельцами параметров. */
describe('полные ошибки текста песни', () => {
  it('сохраняет полную диагностику скобок и Markdown', () => {
    expect(analyzeLyrics('Строка песни\n[Незакрытая секция\n# Заголовок').problems).toEqual([
      'Строка 2: заголовок секции должен быть отдельной строкой вида [Припев], с непустым названием и обеими скобками.',
      'Строка 3: уберите Markdown-разметку или нумерацию. Слова песни пишутся обычным текстом, секции — как [Припев].'
    ]);
  });
  it('сохраняет порядок названий, номера и пример со снятой точкой или двоеточием', () => {
    expect(analyzeLyrics('Припев:\n\nКуплет 2.\nСтрока песни').problems).toEqual([
      'Похоже на названия частей без скобок: «Припев:», «Куплет 2.» (строки 1, 3). Оформите их как [Припев].'
    ]);
    expect(analyzeLyrics('[Куплет 1]').problems).toEqual(['В тексте песни нет ни одной строки. Добавьте слова песни под заголовком секции.']);
  });
});
