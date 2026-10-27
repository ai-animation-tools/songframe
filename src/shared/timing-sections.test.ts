/** Сохранённые секции независимы от строк; автоматическая карта следует их текущим границам. */
import { describe, expect, it } from 'vitest';
import { analyzeLyrics } from './lyrics';
import { buildSections, resolveTimingSections } from './timing-sections';

const lyrics = analyzeLyrics('[Куплет]\nПервая\nВторая\n[Припев]\nТретья').rows;
const lines = [
  { id: 1, source_line: 2, start: 8, end: 12, verified: false, note: '' },
  { id: 2, source_line: 3, start: 12, end: 16, verified: false, note: '' },
  { id: 3, source_line: 5, start: 20, end: 24, verified: false, note: '' }
];

describe('секции шкалы времени', () => {
  it('показывает сохранённые переходы и затухание с исходной точностью после правки строки', () => {
    const saved = [
      { name: 'Короткий переход', start: 16, end: 17.18, note: 'Ручная граница' },
      { name: 'Затухание', start: 28.04, end: 29.2245, note: 'По измерению громкости' }
    ];
    const edited = lines.map((line) => (line.id === 1 ? { ...line, start: 9 } : line));
    expect(resolveTimingSections(saved, lyrics, edited, 30)).toEqual(saved);
    expect(resolveTimingSections(saved, lyrics, edited, 30).at(-1)?.end).toBe(29.2245);
  });

  it.each([undefined, []])('строит секции по текущим строкам, когда сохранённой карты нет: %s', (saved) => {
    const edited = lines.map((line) => (line.id === 1 ? { ...line, start: 9 } : line));
    expect(resolveTimingSections(saved, lyrics, edited, 30)).toEqual(buildSections(lyrics, edited, 30));
    expect(resolveTimingSections(saved, lyrics, edited, 30).find((section) => section.name === 'Куплет')?.start).toBe(9);
  });

  it('обновляет начало секции и вступление сразу после изменения строки', () => {
    expect(buildSections(lyrics, lines, 30).find((section) => section.name === 'Куплет')?.start).toBe(8);
    const edited = lines.map((line) => (line.id === 1 ? { ...line, start: 9 } : line));
    const sections = buildSections(lyrics, edited, 30);
    expect(sections.find((section) => section.name === 'Куплет')).toMatchObject({ start: 9, end: 16 });
    expect(sections[0]).toMatchObject({ name: 'Вступление', start: 0, end: 9 });
    expect(lines[0].start).toBe(8);
  });

  it('пересчитывает промежутки и конец секции после удаления строки', () => {
    const sections = buildSections(
      lyrics,
      lines.filter((line) => line.id !== 2),
      30
    );
    expect(sections.find((section) => section.name === 'Куплет')).toMatchObject({ start: 8, end: 12 });
    expect(sections.find((section) => section.name.startsWith('Проигрыш'))).toMatchObject({ start: 12, end: 20 });
    expect(sections.at(-1)).toMatchObject({ name: 'Финал без вокала', start: 24, end: 30 });
  });
});
