import { describe, expect, it } from 'vitest';
import { addPresetObjects, buildRoom, DEFAULT_ROOM, ROOM_WALL, SCHEME_PRESETS, type SchemePresetObject } from './scheme-presets';
import type { Scheme } from './schemes';

const preset = (id: string): SchemePresetObject[] => SCHEME_PRESETS.find((item) => item.id === id)!.build([10, 20]);
const empty: Scheme = { id: 's1', location: 'l', title: 'Схема', objects: [] };

/** Зеркало правил объёма Go (`internal/schemes`): заготовки обязаны проходить проверку записи. */
function volumeProblem(object: SchemePresetObject): string {
  const kind = object.shape.type;
  if (object.body) {
    if (kind !== 'rect' && kind !== 'ellipse') return 'эллипсоид только у прямоугольника и эллипса';
    if (!object.height || object.height <= 0) return 'эллипсоиду нужна высота';
    if (object.top) return 'у эллипсоида нет верха';
  }
  if (object.height !== undefined && object.height < 0) return 'высота';
  if (object.elevation !== undefined && object.elevation < 0) return 'подъём';
  const top = object.top;
  if (!top) return '';
  if (top.rise <= 0) return 'подъём верха';
  if (top.form === 'ridge' && (kind !== 'rect' || (top.axis !== 'x' && top.axis !== 'y'))) return 'гребень';
  if (top.form === 'slope' && kind !== 'rect') return 'скат';
  if (top.form === 'tent' && kind !== 'rect' && kind !== 'ellipse' && kind !== 'polygon') return 'шатёр';
  return '';
}

describe('заготовки схем', () => {
  it('каждая заготовка даёт объекты, проходящие правила объёма Go, и ставит их вокруг точки', () => {
    for (const item of SCHEME_PRESETS) {
      const objects = item.build([10, 20]);
      expect(objects.length, item.id).toBeGreaterThan(0);
      for (const object of objects) expect(volumeProblem(object), item.id).toBe('');
    }
  });

  it('предметы имеют заданные длину, ширину и высоту', () => {
    const sizes: Record<string, [number, number, number]> = {
      car: [4.6, 1.8, 1.5],
      bus: [12, 2.5, 3],
      truck: [7, 2.5, 3.2],
      bench: [1.8, 0.5, 0.9],
      apartmentHouse: [30, 12, 15],
      table: [1.4, 0.8, 0.75],
      chair: [0.45, 0.45, 0.9],
      wardrobe: [1, 0.6, 2],
      bed: [2, 1.6, 0.5],
      sofa: [2.1, 0.9, 0.85]
    };
    for (const [id, [length, width, height]] of Object.entries(sizes)) {
      const [object] = preset(id);
      expect(object.shape, id).toMatchObject({ type: 'rect', center: [10, 20], size: [length, width] });
      expect(object.height, id).toBe(height);
    }
  });

  it('дом с гребнем, дверь и окно на фасаде', () => {
    expect(preset('house')[0]).toMatchObject({ shape: { size: [10, 8] }, height: 3, top: { form: 'ridge', rise: 2.5, axis: 'x' } });
    expect(preset('door')[0]).toMatchObject({ shape: { size: [1, 0.2] }, height: 2.1 });
    expect(preset('window')[0]).toMatchObject({ shape: { size: [1.4, 0.2] }, height: 1.5, elevation: 0.9 });
  });

  it('столб, светофор, забор, куст и ёлка', () => {
    expect(preset('pole')).toEqual([{ shape: { type: 'point', at: [10, 20] }, height: 7 }]);
    expect(preset('trafficLight')[0]).toMatchObject({ shape: { type: 'point' }, height: 3.5 });
    expect(preset('fence')[0]).toMatchObject({
      shape: {
        type: 'line',
        points: [
          [8, 20],
          [12, 20]
        ]
      },
      height: 1.8
    });
    expect(preset('bush')[0]).toMatchObject({ shape: { type: 'ellipse', radii: [0.8, 0.8] }, height: 1.2, body: 'ellipsoid' });
    expect(preset('spruce')[0]).toMatchObject({ shape: { type: 'ellipse', radii: [1.5, 1.5] }, top: { form: 'tent', rise: 5.5 } });
  });

  it('дерево — ствол и поднятая крона в одной точке', () => {
    const [trunk, crown] = preset('tree');
    expect(trunk).toMatchObject({ shape: { type: 'point', at: [10, 20] }, height: 2 });
    expect(crown).toMatchObject({ shape: { type: 'ellipse', center: [10, 20], radii: [2.5, 2.5] }, height: 4, elevation: 2, body: 'ellipsoid' });
  });

  it('комната — пол и четыре стены внутри рамки пола', () => {
    const objects = buildRoom([0, 0], { width: 4, length: 5, height: 2.7 });
    expect(objects).toHaveLength(5);
    expect(objects[0]).toMatchObject({ part: 'floor', shape: { size: [4, 5] } });
    expect(objects[0].height).toBeUndefined();
    for (const wall of objects.slice(1)) expect(wall.height).toBe(2.7);
    // Габарит стен равен полу: самая дальняя грань каждой стены лежит на рамке пола.
    const edge = (object: SchemePresetObject): [number, number, number, number] => {
      if (object.shape.type !== 'rect') throw new Error('стена — прямоугольник');
      const [cx, cy] = object.shape.center;
      const [sx, sy] = object.shape.size;
      return [cx - sx / 2, cx + sx / 2, cy - sy / 2, cy + sy / 2];
    };
    const edges = objects.slice(1).map(edge);
    expect(Math.min(...edges.map((e) => e[0]))).toBeCloseTo(-2);
    expect(Math.max(...edges.map((e) => e[1]))).toBeCloseTo(2);
    expect(Math.min(...edges.map((e) => e[2]))).toBeCloseTo(-2.5);
    expect(Math.max(...edges.map((e) => e[3]))).toBeCloseTo(2.5);
    expect(ROOM_WALL).toBeLessThan(DEFAULT_ROOM.width);
  });

  it('добавление выдаёт свободные коды и названия частей', () => {
    const base = { ...empty, objects: [{ id: 'o1', name: 'Дом', shape: { type: 'point' as const, at: [0, 0] as [number, number] } }] };
    const { scheme, added } = addPresetObjects(base, preset('tree'), (part) => `Дерево ${part}`);
    expect(added.map((item) => item.id)).toEqual(['o2', 'o3']);
    expect(added.map((item) => item.name)).toEqual(['Дерево trunk', 'Дерево crown']);
    expect(scheme.objects).toHaveLength(3);
    expect(added.every((item) => !('part' in item))).toBe(true);
  });
});
