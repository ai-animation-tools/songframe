import { describe, expect, it } from 'vitest';
import type { SchemesFile } from './schemes';
import {
  createViewpoint,
  distance,
  fovThrough,
  headingBetween,
  lookHeading,
  moves,
  pointAt,
  removePoint,
  setFocus,
  setPoint,
  sideFromPoints,
  sideOfHeading,
  viewSector,
  viewpointFov,
  viewpointHeading,
  withFov,
  withoutPoints,
  type SceneViewpoint
} from './viewpoint';

const base: SceneViewpoint = { location: 'yard', side: 'south', size: 'wide' };

describe('угол обзора', () => {
  it('по крупности, пока свой не задан', () => {
    expect(viewpointFov(base)).toBe(60);
    expect(viewpointFov({ ...base, size: 'close' })).toBe(25);
    expect(viewpointFov({ ...base, size: 'detail', fov: 30 })).toBe(30);
  });

  it('свой угол хранится только при отличии от крупности, в пределах и целым', () => {
    expect(withFov(base, 18.4)).toEqual({ ...base, fov: 18 });
    expect(withFov(base, 60)).toEqual(base);
    expect(withFov({ ...base, fov: 18 }, undefined)).toEqual(base);
    expect(withFov(base, 1)).toEqual({ ...base, fov: 5 });
    expect(withFov(base, 400)).toEqual({ ...base, fov: 120 });
  });
});

describe('направление и сторона', () => {
  it('сторона задаёт взгляд к противоположной стороне', () => {
    expect(viewpointHeading('south')).toBe(90);
    expect(viewpointHeading('north')).toBe(270);
    expect(viewpointHeading('east')).toBe(180);
    expect(viewpointHeading('west')).toBe(0);
    expect(viewpointHeading('top')).toBeNull();
  });

  it('направление между точками в градусах от востока против часовой', () => {
    expect(headingBetween([0, 0], [5, 0])).toBe(0);
    expect(headingBetween([0, 0], [0, 5])).toBe(90);
    expect(headingBetween([0, 0], [-5, 0])).toBe(180);
    expect(headingBetween([0, 0], [0, -5])).toBe(270);
    expect(headingBetween([0, 0], [3, 3])).toBeCloseTo(45, 9);
    expect(headingBetween([1, 1], [1, 1])).toBeNull();
  });

  it('камера стоит со стороны, противоположной взгляду; диагональ уходит по часовой стрелке', () => {
    // Таблица: направление взгляда → сторона камеры.
    const table: [number, string][] = [
      [0, 'west'],
      [30, 'west'],
      [44.9, 'west'],
      [45, 'west'],
      [45.1, 'south'],
      [90, 'south'],
      [135, 'south'],
      [135.1, 'east'],
      [180, 'east'],
      [225, 'east'],
      [225.1, 'north'],
      [270, 'north'],
      [315, 'north'],
      [315.1, 'west'],
      [359.9, 'west'],
      [360, 'west'],
      [-90, 'north']
    ];
    for (const [heading, side] of table) expect([heading, sideOfHeading(heading)]).toEqual([heading, side]);
  });

  it('взгляд от камеры к герою в фокусе; без точек — по стороне; сверху — нет', () => {
    const tracking = setPoint(
      setPoint(setPoint(setPoint(base, 'camera', 'start', [-3, 0]), 'camera', 'end', [-3, 15]), { entity: 'artem' }, 'start', [1, 0]),
      { entity: 'artem' },
      'end',
      [1, 15]
    );
    // Камера на дороге западнее тротуара смотрит на восток: сторона пересчитана в «с запада».
    expect(tracking.side).toBe('west');
    expect(sideFromPoints(tracking)).toBe(true);
    expect(lookHeading(tracking, 'start')).toBe(0);
    expect(lookHeading(tracking, 'end')).toBe(0);
    expect(moves(tracking.camera)).toBe(true);
    // Панорама: камера на месте, герой уходит на север — взгляд поворачивается.
    const pan = setPoint(setPoint(setPoint(base, 'camera', 'start', [0, 0]), { entity: 'boy' }, 'start', [5, 0]), { entity: 'boy' }, 'end', [0, 5]);
    expect(lookHeading(pan, 'start')).toBe(0);
    expect(lookHeading(pan, 'end')).toBe(90);
    expect(moves(pan.camera)).toBe(false);
    expect(lookHeading(base, 'start')).toBe(90);
    expect(lookHeading({ ...tracking, side: 'top' }, 'start')).toBeNull();
    expect(sideFromPoints({ ...tracking, side: 'top' })).toBe(false);
  });
});

describe('правка точек', () => {
  it('конец без начала ставит начало; новый герой встаёт в конец списка', () => {
    const first = setPoint(base, { entity: 'artem' }, 'end', [2, 2]);
    expect(first.subjects).toEqual([{ entity: 'artem', start: [2, 2] }]);
    const two = setPoint(first, { entity: 'kirill' }, 'start', [9, 7]);
    expect(two.subjects?.map((subject) => subject.entity)).toEqual(['artem', 'kirill']);
  });

  it('фокус переставляет героя первым и пересчитывает сторону', () => {
    let viewpoint = setPoint(base, 'camera', 'start', [0, 0]);
    viewpoint = setPoint(viewpoint, { entity: 'artem' }, 'start', [0, 5]);
    viewpoint = setPoint(viewpoint, { entity: 'kirill' }, 'start', [5, 0]);
    expect(viewpoint.side).toBe('south');
    viewpoint = setFocus(viewpoint, 'kirill');
    expect(viewpoint.subjects?.[0].entity).toBe('kirill');
    expect(viewpoint.side).toBe('west');
  });

  it('убирает конец пути или камеру и героя целиком; пустые поля не хранятся', () => {
    let viewpoint = setPoint(setPoint(base, 'camera', 'start', [0, 0]), 'camera', 'end', [0, 4]);
    viewpoint = setPoint(viewpoint, { entity: 'artem' }, 'start', [0, 5]);
    expect(removePoint(viewpoint, 'camera', 'end').camera).toEqual({ start: [0, 0] });
    expect(removePoint(viewpoint, 'camera', 'start').camera).toBeUndefined();
    const withoutHero = removePoint(viewpoint, { entity: 'artem' }, 'start');
    expect('subjects' in withoutHero).toBe(false);
    expect(withoutPoints(viewpoint)).toEqual({ location: 'yard', side: 'south', size: 'wide' });
  });
});

describe('сектор и расстояния', () => {
  it('сектор: от камеры дуга от левого края к правому', () => {
    const sector = viewSector([0, 0], 90, 90, 10, 2);
    expect(sector[0]).toEqual([0, 0]);
    expect(sector[1][0]).toBeCloseTo(-7.0711, 3);
    expect(sector[1][1]).toBeCloseTo(7.0711, 3);
    expect(sector[2][0]).toBeCloseTo(0, 9);
    expect(sector[3][0]).toBeCloseTo(7.0711, 3);
    const north = pointAt([0, 0], 90, 10);
    expect(north[1]).toBeCloseTo(10, 9);
  });

  it('угол через точку края симметричен и учитывает переход через 0°', () => {
    expect(fovThrough([0, 0], 90, [10, 10])).toBeCloseTo(90, 9);
    expect(fovThrough([0, 0], 90, [-10, 10])).toBeCloseTo(90, 9);
    expect(fovThrough([0, 0], 0, [10, -10])).toBeCloseTo(90, 9);
    expect(fovThrough([0, 0], 0, [-10, 0])).toBeCloseTo(360, 9);
    expect(distance([0, 0], [3, 4])).toBe(5);
  });
});

describe('новая точка съёмки', () => {
  const schemes: SchemesFile = { schema_version: 1, schemes: [{ id: 's1', location: 'street', title: 'Улица', view: 'top', objects: [] }] };
  it('берёт единственную локацию с видом сверху, иначе первую', () => {
    expect(createViewpoint(['yard', 'street'], schemes)).toEqual({ location: 'street', side: 'south', size: 'wide' });
    expect(createViewpoint(['yard', 'street'], null)).toEqual({ location: 'yard', side: 'south', size: 'wide' });
    expect(createViewpoint([], schemes)).toBeNull();
  });
});
