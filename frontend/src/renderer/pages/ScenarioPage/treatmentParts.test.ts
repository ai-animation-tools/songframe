/**
 * Части трактовки из музыкальной карты: границы встык от 0 до конца трека, хотя секции карты
 * оставляют короткие промежутки и перекрываются.
 */
import { describe, expect, it } from 'vitest';
import type { TimingSection, TreatmentSequence } from '@shared/types';
import { partsFromSections, patchTreatmentPart } from './treatmentParts';

const bounds = (sections: TimingSection[], duration: number | null) => partsFromSections(sections, duration).map(({ id, start, end }) => ({ id, start, end }));

describe('partsFromSections', () => {
  it('закрывает промежутки и снимает перекрытия: конец части — начало следующей, последняя до конца трека', () => {
    const sections: TimingSection[] = [
      { name: 'Куплет 1', start: 1.2345, end: 36.78, note: 'строки 1–4' },
      { name: 'Припев', start: 38.043, end: 60.5, note: 'строки 5–8' },
      { name: 'Куплет 2', start: 59.9, end: 90.1, note: 'строки 9–12' },
      { name: 'Финал без вокала', start: 91, end: 95, note: 'до конца трека' }
    ];
    expect(bounds(sections, 97.0004)).toEqual([
      { id: 'verse', start: 0, end: 38.043 },
      { id: 'chorus', start: 38.043, end: 59.9 },
      { id: 'verse_2', start: 59.9, end: 91 },
      { id: 'final', start: 91, end: 97 }
    ]);
  });

  it('сортирует секции по началу и сохраняет остальные поля части', () => {
    const parts = partsFromSections(
      [
        { name: 'Проигрыш', start: 20, end: 25, note: 'без вокала' },
        { name: 'Вступление', start: 0, end: 5, note: 'без вокала' },
        { name: 'Припев', start: 5.0001, end: 19 }
      ],
      30
    );
    expect(parts).toEqual([
      { id: 'intro', title: 'Вступление', direction: '', start: 0, end: 5, entities: [], lipsync: false, max_shot_seconds: 6 },
      { id: 'chorus', title: 'Припев', direction: '', start: 5, end: 20, entities: [], lipsync: false, max_shot_seconds: 6 },
      { id: 'bridge', title: 'Проигрыш', direction: '', start: 20, end: 30, entities: [], lipsync: false, max_shot_seconds: 6 }
    ]);
  });

  it('без длительности трека последняя часть заканчивается на конце своей секции', () => {
    expect(bounds([{ name: 'Песня', start: 3, end: 12.3456 }], null)).toEqual([{ id: 'part1', start: 0, end: 12.346 }]);
  });

  it('совпавшие начала оставляют часть нулевой длины для списка проблем', () => {
    expect(
      bounds(
        [
          { name: 'Куплет', start: 0, end: 10 },
          { name: 'Припев', start: 10, end: 20 },
          { name: 'Не размечено', start: 10, end: 12 }
        ],
        20
      )
    ).toEqual([
      { id: 'verse', start: 0, end: 10 },
      { id: 'chorus', start: 10, end: 10 },
      { id: 'part3', start: 10, end: 20 }
    ]);
  });

  it('пустая карта даёт пустой список частей', () => {
    expect(partsFromSections([], 30)).toEqual([]);
  });
});

describe('patchTreatmentPart', () => {
  const parts: TreatmentSequence[] = [
    { id: 'intro', title: 'Вступление', direction: '', start: 0, end: 10, entities: [] },
    { id: 'verse', title: 'Куплет', direction: '', start: 10, end: 40, entities: [] },
    { id: 'final', title: 'Финал', direction: '', start: 40, end: 60, entities: [] }
  ];
  const edges = (list: TreatmentSequence[]) => list.map(({ start, end }) => [start, end]);

  it('начало части двигает конец предыдущей, конец — начало следующей', () => {
    expect(edges(patchTreatmentPart(parts, 1, { start: 12.5 }))).toEqual([
      [0, 12.5],
      [12.5, 40],
      [40, 60]
    ]);
    expect(edges(patchTreatmentPart(parts, 1, { end: 38 }))).toEqual([
      [0, 10],
      [10, 38],
      [38, 60]
    ]);
  });

  it('начало первой и конец последней части меняются без соседей, прочие поля не трогают границ', () => {
    expect(edges(patchTreatmentPart(parts, 0, { start: 1 }))).toEqual([
      [1, 10],
      [10, 40],
      [40, 60]
    ]);
    expect(edges(patchTreatmentPart(parts, 2, { end: 61 }))).toEqual([
      [0, 10],
      [10, 40],
      [40, 61]
    ]);
    expect(patchTreatmentPart(parts, 1, { title: 'Куплет 1' })[1].title).toBe('Куплет 1');
    expect(edges(patchTreatmentPart(parts, 1, { title: 'Куплет 1' }))).toEqual(edges(parts));
  });
});
