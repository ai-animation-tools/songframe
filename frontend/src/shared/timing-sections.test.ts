/** Сохранённые секции независимы от строк; автоматическая карта следует их текущим границам. */
import { describe, expect, it } from 'vitest';
import { analyzeLyrics } from './lyrics';
import { buildSections, resolveTimingSections } from './timing-sections';
import type { TimingSection } from './types';

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
    expect(sections.find((section) => section.start === 12)).toMatchObject({ name: 'Не размечено', start: 12, end: 20 });
    expect(sections.at(-1)).toMatchObject({ name: 'Не размечено', start: 24, end: 30 });
  });

  it('пересчитывает старые автоматические границы по полной системной подписи', () => {
    const old = buildSections(
      lyrics,
      lines.map((line) => ({ ...line, start: line.start + 3, end: line.end + 3 })),
      30
    ).map(({ origin: _origin, ...section }) => section);
    expect(resolveTimingSections(old, lyrics, lines, 30)).toEqual(buildSections(lyrics, lines, 30));
    expect(resolveTimingSections(old, lyrics, lines, 30)[0]).toMatchObject({ end: 8, origin: 'auto' });
  });

  it('сохраняет явно ручную секцию и её приоритет над автоматически построенной частью', () => {
    const manual: TimingSection = { name: 'Куплет', start: 7.25, end: 17.75, note: 'строки 1–2', origin: 'manual' };
    const mixed = [...buildSections(lyrics, lines, 30), manual];
    const result = resolveTimingSections(mixed, lyrics, lines, 30);
    expect(result.filter((section) => section.name === 'Куплет')).toEqual([manual]);
    expect(result.every((section, index) => index === 0 || section.start >= result[index - 1].start)).toBe(true);
    expect(resolveTimingSections([manual], lyrics, lines, 30)).toEqual([manual]);
  });

  it('не считает произвольные ручные названия и заметки старой автоматикой', () => {
    const custom = [
      { name: 'Особая часть', start: 0, end: 1, note: 'строки 1–2' },
      { name: 'Вступление', start: 1, end: 3, note: 'Моя заметка' },
      { name: 'Мой финал', start: 25, end: 30, note: 'до конца трека' },
      { name: 'Куплет', start: 8, end: 16, note: 'строки 1–2\n' }
    ];
    expect(resolveTimingSections(custom, lyrics, lines, 30)).toEqual(custom);
  });

  it('учитывает пересекающийся кандидат в вокальной части и не называет неизвестные области инструменталом', () => {
    const candidates = [{ source_line: 3, start: 11.98, end: 18, reason: 'Слабое сходство', acoustic_score: 0.7 }];
    const accepted = lines.filter((line) => line.source_line !== 3);
    const result = buildSections(lyrics, accepted, 30, candidates);
    expect(result.find((section) => section.name === 'Куплет')).toMatchObject({ start: 8, end: 18, origin: 'auto' });
    expect(result.find((section) => section.start === 18)).toMatchObject({ name: 'Не размечено', end: 20 });
    expect(result.filter((section) => section.name === 'Не размечено').every((section) => section.note === 'границы вокала не подтверждены')).toBe(true);
    expect(result.some((section) => section.note === 'без вокала' || section.note === 'до конца трека')).toBe(false);
    expect(resolveTimingSections(buildSections(lyrics, lines, 30), lyrics, accepted, 30, candidates)).toEqual(result);
  });

  it('принятая строка имеет приоритет над кандидатом с тем же физическим номером', () => {
    const candidates = [{ source_line: 3, start: 1, end: 29, reason: 'Слабое сходство' }];
    expect(buildSections(lyrics, lines, 30, candidates).find((section) => section.name === 'Куплет')).toMatchObject({ start: 8, end: 16 });
  });
});
