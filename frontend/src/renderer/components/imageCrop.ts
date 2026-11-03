/** Координаты выделения хранятся в пикселях оригинала независимо от масштаба предпросмотра. */
import type { CoverCrop } from '@shared/cover-generation';

export interface ImageSize {
  width: number;
  height: number;
}

export function clampCrop(crop: CoverCrop, image: ImageSize): CoverCrop {
  const size = Math.max(1, Math.min(Math.round(crop.size), image.width, image.height));
  return {
    x: Math.max(0, Math.min(Math.round(crop.x), image.width - size)),
    y: Math.max(0, Math.min(Math.round(crop.y), image.height - size)),
    size
  };
}

export function centeredCrop(image: ImageSize): CoverCrop {
  const size = Math.min(image.width, image.height);
  return clampCrop({ x: (image.width - size) / 2, y: (image.height - size) / 2, size }, image);
}

/** Изменение размера сохраняет центр до тех пор, пока выделение не упирается в край. */
export function resizeCrop(crop: CoverCrop, size: number, image: ImageSize): CoverCrop {
  const nextSize = Math.max(1, Math.min(Math.round(size), image.width, image.height));
  // Одинаковый пиксель центра исключает накопление округления при шагах ползунка по одному пикселю.
  const offset = Math.floor(crop.size / 2) - Math.floor(nextSize / 2);
  return clampCrop({ x: crop.x + offset, y: crop.y + offset, size: nextSize }, image);
}

export function moveCrop(crop: CoverCrop, dx: number, dy: number, image: ImageSize): CoverCrop {
  return clampCrop({ ...crop, x: crop.x + dx, y: crop.y + dy }, image);
}

export function keyboardCrop(crop: CoverCrop, key: string, shift: boolean, image: ImageSize): CoverCrop {
  const step = shift ? 10 : 1;
  const offsets: Record<string, [number, number]> = {
    ArrowLeft: [-step, 0],
    ArrowRight: [step, 0],
    ArrowUp: [0, -step],
    ArrowDown: [0, step]
  };
  const offset = offsets[key];
  return offset ? moveCrop(crop, ...offset, image) : crop;
}
