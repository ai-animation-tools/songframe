/**
 * Общая таблица случаев фактов кадра (testdata/golden/viewframe/cases.json): Go считает по ней полные факты для
 * агентов (internal/viewframe), здесь та же таблица проверяет карту точки съёмки — направление взгляда, попадание
 * героев в кадр, расстояние до объектов схемы и их попадание в кадр. Так карта и агент не расходятся.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import type { Scheme } from './schemes';
import { distance, footprintView, inFrame, lookHeading, pathPoint, type SceneViewpoint, type ViewpointPhase } from './viewpoint';

interface PhaseFacts {
  looks: string;
  subjects: { entity: string; in_frame: boolean; distance: number }[];
  objects: { name: string; in_frame: boolean; distance: number }[];
}

interface CaseFile {
  schemes: Record<string, Scheme>;
  cases: {
    name: string;
    input: { viewpoint: SceneViewpoint; scheme: string | null };
    expected: { start: PhaseFacts | null; end: PhaseFacts | null };
  }[];
}

const file = JSON.parse(readFileSync(new URL('../../../testdata/golden/viewframe/cases.json', import.meta.url), 'utf8')) as CaseFile;

/** Направление словами, как у Go: ближайшая из восьми сторон света. */
const COMPASS = ['на восток', 'на северо-восток', 'на север', 'на северо-запад', 'на запад', 'на юго-запад', 'на юг', 'на юго-восток'];
const compass = (heading: number): string => COMPASS[Math.round((((heading % 360) + 360) % 360) / 45) % 8];

/** Округление как у Go: половина — от нуля. */
const round1 = (value: number): number => (Math.sign(value) * Math.round(Math.abs(value) * 10)) / 10;

describe('Факты кадра: общая таблица с Go', () => {
  it('таблица не пуста', () => {
    expect(file.cases.length).toBeGreaterThan(0);
  });
  for (const item of file.cases) {
    for (const phase of ['start', 'end'] as ViewpointPhase[]) {
      const facts = item.expected[phase];
      if (!facts) continue;
      it(`${item.name} · ${phase}`, () => {
        const { viewpoint } = item.input;
        const scheme = file.schemes[item.input.scheme!];
        expect(compass(lookHeading(viewpoint, phase)!)).toBe(facts.looks);
        const camera = pathPoint(viewpoint.camera, phase)!;
        for (const subject of facts.subjects) {
          const path = viewpoint.subjects!.find((candidate) => candidate.entity === subject.entity)!;
          const at = pathPoint(path, phase)!;
          expect(inFrame(viewpoint, phase, at), subject.entity).toBe(subject.in_frame);
          expect(round1(distance(camera, at)), subject.entity).toBe(subject.distance);
        }
        for (const object of facts.objects) {
          const shape = scheme.objects.find((candidate) => candidate.name === object.name)!.shape;
          const view = footprintView(viewpoint, phase, [shape])!;
          expect(view.inFrame, object.name).toBe(object.in_frame);
          expect(round1(view.distance), object.name).toBe(object.distance);
        }
      });
    }
  }
});
