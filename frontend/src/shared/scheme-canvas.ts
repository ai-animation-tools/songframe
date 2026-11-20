import type { SchemePoint, SchemeViewKind } from './schemes';

/**
 * Пересчёт между метрами схемы и пикселями холста. Ось Y экрана направлена вниз, поэтому север (вид сверху) и высота
 * (виды сбоку) откладываются вверх. На видах сбоку горизонталь хранит координату мира; направление на экране — как
 * у стоящего наблюдателя: с юга запад слева (X растёт вправо), с севера восток слева (X растёт влево), с востока юг
 * слева (Y растёт вправо), с запада север слева (Y растёт влево).
 */

/** Видимая область холста: центр в метрах, масштаб в пикселях на метр и размер в пикселях. */
export interface Viewport {
  center: SchemePoint;
  scale: number;
  width: number;
  height: number;
}

/** Знак горизонтальной оси: +1 — координата растёт вправо, −1 — влево. */
export function horizontalSign(view: SchemeViewKind): 1 | -1 {
  return view === 'north' || view === 'west' ? -1 : 1;
}

/** Пиксели холста для точки схемы. */
export function toScreen(point: SchemePoint, viewport: Viewport, view: SchemeViewKind): SchemePoint {
  const sign = horizontalSign(view);
  return [viewport.width / 2 + sign * (point[0] - viewport.center[0]) * viewport.scale, viewport.height / 2 - (point[1] - viewport.center[1]) * viewport.scale];
}

/** Точка схемы для пикселей холста; обратна toScreen. */
export function toWorld(pixel: SchemePoint, viewport: Viewport, view: SchemeViewKind): SchemePoint {
  const sign = horizontalSign(view);
  return [
    viewport.center[0] + (sign * (pixel[0] - viewport.width / 2)) / viewport.scale,
    viewport.center[1] - (pixel[1] - viewport.height / 2) / viewport.scale
  ];
}

/** Масштаб, при котором рамка [minX, minY, maxX, maxY] с полями помещается в холст. */
export function fitViewport(bounds: [number, number, number, number] | null, width: number, height: number): Viewport {
  if (!bounds) return { center: [0, 0], scale: 10, width, height };
  const spanX = Math.max(bounds[2] - bounds[0], 4);
  const spanY = Math.max(bounds[3] - bounds[1], 4);
  const scale = Math.min((width * 0.85) / spanX, (height * 0.85) / spanY);
  return { center: [(bounds[0] + bounds[2]) / 2, (bounds[1] + bounds[3]) / 2], scale: clampScale(scale), width, height };
}

/** Масштаб в разумных пределах: от 0,5 до 200 пикселей на метр. */
export function clampScale(scale: number): number {
  return Math.min(200, Math.max(0.5, scale));
}

/** Шаги сетки в метрах по ряду 1–2–5: от 1 см для мебели в комнате до километра для района. */
const GRID_STEPS = [0.01, 0.02, 0.05, 0.1, 0.2, 0.5, 1, 2, 5, 10, 20, 50, 100, 200, 500, 1000] as const;

/** Шаг сетки в метрах: самая мелкая клетка не меньше 12 пикселей. */
export function gridStep(scale: number): number {
  return GRID_STEPS.find((step) => step * scale >= 12) ?? GRID_STEPS[GRID_STEPS.length - 1];
}

/**
 * Привязка координаты к сетке: к ближайшей линии клетки step. Клетка зависит от масштаба, поэтому крупно нарисованное
 * получается целыми метрами, а приближенное — сантиметрами. Хвосты двоичной арифметики срезаются до миллиметра.
 */
export function snap(value: number, step: number): number {
  return Math.round(Math.round(value / step) * step * 1000) / 1000 || 0;
}

/** Длина в метрах для подписи на холсте: русская запятая, без лишних нулей (0,6 м; 12 м). */
export function formatMetres(value: number): string {
  return String(Math.round(value * 1000) / 1000).replace('.', ',');
}
