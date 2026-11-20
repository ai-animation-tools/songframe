import { describe, expect, it } from 'vitest';
import type { Scheme, SchemeShape, SchemesFile } from './schemes';
import {
  aimHeading,
  angleFrom,
  createViewpoint,
  distance,
  footprintView,
  fovThrough,
  headingBetween,
  inFrame,
  linkedShapes,
  lookHeading,
  moves,
  pointAt,
  removePoint,
  setHeading,
  setCameraHeight,
  cameraHeight,
  setFocus,
  setPoint,
  sideFromPoints,
  sideOfHeading,
  viewSector,
  viewpointFov,
  viewpointHeading,
  withFov,
  withoutHeading,
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

  it('взгляд от камеры на героя; без точек — по стороне; сверху — нет', () => {
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

  it('фокус переставляет героя первым, прицел на всех героев и сторона не меняются', () => {
    let viewpoint = setPoint(base, 'camera', 'start', [0, 0]);
    viewpoint = setPoint(viewpoint, { entity: 'artem' }, 'start', [0, 5]);
    expect(viewpoint.side).toBe('south');
    // Второй герой на востоке: прицел посередине (45°), северо-восток относится к востоку — камера с запада.
    viewpoint = setPoint(viewpoint, { entity: 'kirill' }, 'start', [5, 0]);
    expect(lookHeading(viewpoint, 'start')).toBeCloseTo(45, 9);
    expect(viewpoint.side).toBe('west');
    viewpoint = setFocus(viewpoint, 'kirill');
    expect(viewpoint.subjects?.[0].entity).toBe('kirill');
    expect(viewpoint.side).toBe('west');
    expect(lookHeading(viewpoint, 'start')).toBeCloseTo(45, 9);
  });

  it('прицел — середина углового разброса героев, в том числе через 0°; герой в точке камеры не считается', () => {
    expect(aimHeading([0, 0], [[10, 0]])).toBe(0);
    expect(
      aimHeading(
        [0, 0],
        [
          [10, -1.763],
          [10, 1.763],
          [10, 0.5]
        ]
      )
    ).toBeCloseTo(0, 2);
    expect(
      aimHeading(
        [0, 0],
        [
          [-5, 5],
          [5, 5],
          [0, 5]
        ]
      )
    ).toBeCloseTo(90, 9);
    expect(aimHeading([0, 0], [[0, 0]])).toBeNull();
    expect(aimHeading([0, 0], [])).toBeNull();
  });

  it('в кадре — герои в пределах половины угла обзора от прицела', () => {
    // Камера южнее двух героев, разнесённых на 10 м в 11 м перед ней: им нужно около 49°.
    const pair: SceneViewpoint = {
      ...base,
      fov: 30,
      camera: { start: [0, -28] },
      subjects: [
        { entity: 'ivan', start: [-5, -17] },
        { entity: 'pasha', start: [5, -17] },
        { entity: 'tree', start: [-9, -15] }
      ]
    };
    expect(lookHeading(pair, 'start')).toBeCloseTo(
      90 + (angleFrom(90, headingBetween([0, -28], [5, -17])!) + angleFrom(90, headingBetween([0, -28], [-9, -15])!)) / 2,
      9
    );
    const two = { ...pair, subjects: pair.subjects!.slice(0, 2) };
    expect(lookHeading(two, 'start')).toBeCloseTo(90, 9);
    expect(inFrame(two, 'start', [-5, -17])).toBe(false);
    expect(inFrame({ ...two, fov: 50 }, 'start', [-5, -17])).toBe(true);
    expect(inFrame({ ...two, fov: 50 }, 'start', [5, -17])).toBe(true);
    expect(inFrame({ ...two, side: 'top' }, 'start', [5, -17])).toBeNull();
    expect(inFrame({ ...base }, 'start', [5, -17])).toBeNull();
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
  const schemes: SchemesFile = { schema_version: 1, schemes: [{ id: 's1', location: 'street', title: 'Улица', objects: [] }] };
  it('берёт единственную локацию с видом сверху, иначе первую', () => {
    expect(createViewpoint(['yard', 'street'], schemes)).toEqual({ location: 'street', side: 'south', size: 'wide' });
    expect(createViewpoint(['yard', 'street'], null)).toEqual({ location: 'yard', side: 'south', size: 'wide' });
    expect(createViewpoint([], schemes)).toBeNull();
  });
});

describe('своё направление камеры', () => {
  const placed: SceneViewpoint = { ...base, camera: { start: [0, 0] }, subjects: [{ entity: 'artem', start: [0, 5] }] };

  it('заменяет прицел на героев, задаёт сторону и отметки кадра; конец без своего — как начало', () => {
    expect(lookHeading(placed, 'start')).toBe(90);
    const turned = setHeading(placed, 'start', 0.4);
    expect(turned.heading).toEqual({ start: 0 });
    expect(turned.side).toBe('west');
    expect(lookHeading(turned, 'start')).toBe(0);
    expect(lookHeading(turned, 'end')).toBe(0);
    expect(inFrame(turned, 'start', [0, 5])).toBe(false);
    expect(sideFromPoints(turned)).toBe(true);
  });

  it('конец без своего начала начинает поворот с текущего направления; конец как начало не хранится', () => {
    const pan = setHeading(placed, 'end', -90);
    expect(pan.heading).toEqual({ start: 90, end: 270 });
    expect(lookHeading(pan, 'end')).toBe(270);
    expect(pan.side).toBe('south');
    expect(setHeading(pan, 'end', 90).heading).toEqual({ start: 90 });
    expect(setHeading(placed, 'start', 359.6).heading).toEqual({ start: 0 });
  });

  it('прицел на героев возвращается кнопкой; без камеры и при смене локации направление уходит', () => {
    const turned = setHeading(placed, 'start', 0);
    const back = withoutHeading(turned);
    expect('heading' in back).toBe(false);
    expect(back.side).toBe('south');
    expect('heading' in removePoint(turned, 'camera', 'start')).toBe(false);
    expect(removePoint(setHeading({ ...turned, camera: { start: [0, 0], end: [1, 0] } }, 'end', 45), 'camera', 'end').heading).toEqual({ start: 0, end: 45 });
    expect('heading' in withoutPoints(turned)).toBe(false);
    expect(lookHeading({ ...turned, side: 'top' }, 'start')).toBeNull();
  });
});

describe('предмет схемы как референс плана', () => {
  // Камера в 10 м южнее дома 6×6, смотрит на север.
  const house: SchemeShape = { type: 'rect', center: [0, 10], size: [6, 6] };
  const looking: SceneViewpoint = { ...base, camera: { start: [0, -3] }, heading: { start: 90 } };

  it('расстояние — до ближайшего края контура, а не до центра или угла', () => {
    expect(footprintView(looking, 'start', [house])!.distance).toBeCloseTo(10, 9);
    expect(footprintView({ ...looking, camera: { start: [0, 10] } }, 'start', [house])!.distance).toBe(0);
    expect(footprintView({ ...base }, 'start', [house])).toBeNull();
  });

  it('в кадре, если хоть часть контура в угле обзора; длинная стена с концами за краями кадра — тоже', () => {
    expect(footprintView({ ...looking, fov: 10 }, 'start', [house])!.inFrame).toBe(true);
    expect(footprintView({ ...looking, heading: { start: 0 }, fov: 30 }, 'start', [house])!.inFrame).toBe(false);
    const wall: SchemeShape = {
      type: 'line',
      points: [
        [-50, 20],
        [50, 20]
      ]
    };
    expect(footprintView({ ...looking, fov: 5 }, 'start', [wall])!.inFrame).toBe(true);
    // Стена позади камеры, огибающая её с обеих сторон, в кадр не попадает.
    const behind: SchemeShape = {
      type: 'line',
      points: [
        [-50, -10],
        [50, -10]
      ]
    };
    expect(footprintView({ ...looking, fov: 60 }, 'start', [behind])!.inFrame).toBe(false);
    expect(footprintView({ ...looking, side: 'top' }, 'start', [house])!.inFrame).toBeNull();
  });

  it('фигуры предмета — объекты схемы со ссылкой на сущность', () => {
    const scheme: Scheme = {
      id: 's',
      location: 'yard',
      title: 'Двор',
      objects: [
        { id: 'o1', name: 'Дом', shape: house, entity: 'dom' },
        { id: 'o2', name: 'Пристройка', shape: { type: 'point', at: [5, 5] }, entity: 'dom' },
        { id: 'o3', name: 'Забор', shape: { type: 'point', at: [9, 9] } }
      ]
    };
    expect(linkedShapes(scheme, 'dom')).toHaveLength(2);
    expect(linkedShapes(scheme, 'stol')).toEqual([]);
    expect(linkedShapes(null, 'dom')).toEqual([]);
  });
});

describe('высота камеры', () => {
  const base: SceneViewpoint = { location: 'yard', side: 'south', size: 'wide', camera: { start: [0, 0] } };

  it('по умолчанию уровень глаз, своя — на кадре, уровень глаз без подъёма не хранится', () => {
    expect(cameraHeight(base, 'start')).toBe(1.6);
    const low = setCameraHeight(base, 'start', 0.304);
    expect(low.camera_height).toEqual({ start: 0.3 });
    expect(cameraHeight(low, 'end')).toBe(0.3);
    const crane = setCameraHeight(low, 'end', 12);
    expect(crane.camera_height).toEqual({ start: 0.3, end: 12 });
    expect(cameraHeight(crane, 'end')).toBe(12);
    // Конец, равный началу, и уровень глаз без подъёма не пишутся.
    expect(setCameraHeight(crane, 'end', 0.3).camera_height).toEqual({ start: 0.3 });
    expect(setCameraHeight(low, 'start', 1.6).camera_height).toBeUndefined();
    // Подъём с уровня глаз хранит начало явно.
    expect(setCameraHeight(base, 'end', 5).camera_height).toEqual({ start: 1.6, end: 5 });
    expect(setCameraHeight(base, 'start', 9999).camera_height).toEqual({ start: 500 });
  });
});
