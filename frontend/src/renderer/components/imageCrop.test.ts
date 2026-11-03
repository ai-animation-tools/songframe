/** Проверки естественных координат: масштаб интерфейса не влияет на сохраняемый квадрат. */
import { describe, expect, it } from 'vitest';
import { centeredCrop, clampCrop, keyboardCrop, moveCrop, resizeCrop } from './imageCrop';

describe('Выделение обложки', () => {
  it('выбирает наибольший квадрат по центру горизонтального и вертикального оригинала', () => {
    expect(centeredCrop({ width: 1600, height: 900 })).toEqual({ x: 350, y: 0, size: 900 });
    expect(centeredCrop({ width: 900, height: 1600 })).toEqual({ x: 0, y: 350, size: 900 });
  });

  it('ограничивает размер и обе координаты границами изображения', () => {
    expect(clampCrop({ x: -12, y: 999, size: 1000 }, { width: 800, height: 600 })).toEqual({ x: 0, y: 0, size: 600 });
    expect(clampCrop({ x: 999, y: -10, size: 300 }, { width: 800, height: 600 })).toEqual({ x: 500, y: 0, size: 300 });
    expect(clampCrop({ x: 1.7, y: 3.2, size: 0 }, { width: 800, height: 600 })).toEqual({ x: 2, y: 3, size: 1 });
  });

  it('изменяет размер вокруг центра и сдвигает квадрат у края', () => {
    const image = { width: 1200, height: 800 };
    expect(resizeCrop({ x: 200, y: 100, size: 600 }, 200, image)).toEqual({ x: 400, y: 300, size: 200 });
    expect(resizeCrop({ x: 0, y: 0, size: 200 }, 600, image)).toEqual({ x: 0, y: 0, size: 600 });
    expect(resizeCrop({ x: 1000, y: 600, size: 200 }, 600, image)).toEqual({ x: 600, y: 200, size: 600 });
  });

  it('ограничивает перетаскивание и округляет естественные пиксели', () => {
    expect(moveCrop({ x: 100, y: 100, size: 200 }, 1000, -1000, { width: 800, height: 600 })).toEqual({ x: 600, y: 0, size: 200 });
    expect(moveCrop({ x: 100, y: 100, size: 200 }, 3.6, 1.4, { width: 800, height: 600 })).toEqual({ x: 104, y: 101, size: 200 });
  });

  it('не накапливает сдвиг центра при последовательных шагах ползунка', () => {
    const image = { width: 64, height: 36 };
    let crop = centeredCrop(image);
    for (let size = 35; size >= 18; size--) crop = resizeCrop(crop, size, image);
    expect(crop).toEqual({ x: 23, y: 9, size: 18 });
    for (let size = 19; size <= 36; size++) crop = resizeCrop(crop, size, image);
    expect(crop).toEqual(centeredCrop(image));
  });

  it('перемещает стрелками по пикселю, с Shift по десять и останавливается у края', () => {
    const image = { width: 800, height: 600 };
    const crop = { x: 5, y: 5, size: 200 };
    expect(keyboardCrop(crop, 'ArrowRight', false, image)).toEqual({ x: 6, y: 5, size: 200 });
    expect(keyboardCrop(crop, 'ArrowDown', true, image)).toEqual({ x: 5, y: 15, size: 200 });
    expect(keyboardCrop(crop, 'ArrowLeft', true, image)).toEqual({ x: 0, y: 5, size: 200 });
    expect(keyboardCrop(crop, 'Enter', false, image)).toBe(crop);
  });
});
