import type { TimingLine } from '@shared/types';
import { MIN_LENGTH, neighbours, round } from './timing';

export const WAVE_TOP = 24;
export const WAVE_H = 110;
const TIME_SCALE_H = 20;
const LANE_H = 42;
const HANDLE_TOLERANCE = 6;
const MIN_BLOCK_W = 20;

export type TimingDragMode = 'start' | 'end' | 'move';
export interface TimingBlockGeometry {
  line: TimingLine;
  left: number;
  right: number;
  startX: number;
  endX: number;
  top: number;
  height: number;
  lane: number;
}
export interface TimingWaveLayout {
  blocks: TimingBlockGeometry[];
  waveHeight: number;
  canvasHeight: number;
}

/** Одинаковая геометрия рисования и мыши сохраняет доступ к каждому перекрытому интервалу.
 * Нулевые и обратные интервалы остаются объектами с двумя раздельными ручками до сохранения. */
export function timingWaveLayout(lines: TimingLine[], pps: number, manualMode = false): TimingWaveLayout {
  const blocks: TimingBlockGeometry[] = [];
  const lanes: { left: number; right: number }[][] = [];
  if (!Number.isFinite(pps) || pps <= 0) return { blocks, waveHeight: WAVE_H, canvasHeight: WAVE_TOP + WAVE_H + TIME_SCALE_H };
  for (const line of [...lines].sort((a, b) => a.id - b.id)) {
    if (!Number.isFinite(line.start) || !Number.isFinite(line.end)) continue;
    let startX = line.start * pps;
    let endX = line.end * pps;
    if (!Number.isFinite(startX) || !Number.isFinite(endX) || !Number.isFinite(endX - startX)) continue;
    // Минимальная экранная ширина нужна только для мыши и не исправляет введённые времена.
    if (manualMode && Math.abs(endX - startX) < MIN_BLOCK_W) {
      const middle = startX + (endX - startX) / 2;
      const direction = line.end < line.start ? -1 : 1;
      startX = middle - (MIN_BLOCK_W / 2) * direction;
      endX = middle + (MIN_BLOCK_W / 2) * direction;
      // У нулевой отметки обе ручки остаются видимыми; время строки при этом не меняется.
      const shift = Math.max(0, -Math.min(startX, endX));
      startX += shift;
      endX += shift;
    }
    const left = Math.min(startX, endX);
    const right = Math.max(startX, endX);
    const lane = manualMode
      ? lanes.findIndex((occupied) => occupied.every((block) => right + HANDLE_TOLERANCE < block.left || left - HANDLE_TOLERANCE > block.right))
      : 0;
    const index = lane < 0 ? lanes.length : lane;
    if (!lanes[index]) lanes[index] = [];
    lanes[index].push({ left, right });
    blocks.push({ line, left, right, startX, endX, top: WAVE_TOP + (manualMode ? index * LANE_H : 0), height: manualMode ? LANE_H - 4 : WAVE_H, lane: index });
  }
  const waveHeight = manualMode ? Math.max(WAVE_H, lanes.length * LANE_H) : WAVE_H;
  return { blocks, waveHeight, canvasHeight: WAVE_TOP + waveHeight + TIME_SCALE_H };
}

/** Координаты берутся в пространстве всей дорожки: прокрутка влияет только на перевод мыши и canvas. */
export function hitTimingBlock(layout: TimingWaveLayout, x: number, y: number): { line: TimingLine; mode: TimingDragMode } | null {
  const candidates = layout.blocks.filter((block) => y >= block.top && y <= block.top + block.height);
  for (const block of candidates) {
    if (Math.abs(x - block.startX) <= HANDLE_TOLERANCE) return { line: block.line, mode: 'start' };
    if (Math.abs(x - block.endX) <= HANDLE_TOLERANCE) return { line: block.line, mode: 'end' };
  }
  const inside = candidates.find((block) => x >= block.left && x <= block.right);
  return inside ? { line: inside.line, mode: 'move' } : null;
}

/** Ручной черновик свободно проходит через соседей и собственную вторую границу.
 * В обычном режиме прежние ограничения сохраняются; перенос всегда считается от исходного интервала. */
export function timingDragPatch(
  original: TimingLine,
  mode: TimingDragMode,
  time: number,
  offset: number,
  lines: TimingLine[],
  duration: number,
  manualMode = false
): Partial<TimingLine> | null {
  // Подтверждение закрепляет границы на шкале, включая перенос горячими клавишами.
  // Проверяем и актуальную строку: её могли подтвердить уже после захвата мышью.
  if (original.verified || lines.some((line) => line.id === original.id && line.verified)) return null;
  if (!Number.isFinite(time) || !Number.isFinite(offset)) return null;
  const limit = Number.isFinite(duration) && duration > 0 ? duration : Infinity;
  // Смещение захвата компенсирует расширенную экранную ручку: resize двигает исходную границу на дельту мыши.
  const proposed = time - offset;
  const boundedTime = Math.max(0, Math.min(limit, proposed));
  if (manualMode && mode !== 'move') return mode === 'start' ? { start: round(boundedTime) } : { end: round(boundedTime) };
  if (!Number.isFinite(original.start) || !Number.isFinite(original.end)) return null;
  const { prevEnd, nextStart } = manualMode ? { prevEnd: 0, nextStart: limit } : neighbours(original.id, lines, duration);
  if (mode === 'start') return { start: round(Math.max(prevEnd, Math.min(original.end - MIN_LENGTH, boundedTime))) };
  if (mode === 'end') return { end: round(Math.min(nextStart, Math.max(original.start + MIN_LENGTH, boundedTime))) };
  const length = original.end - original.start;
  const start = manualMode
    ? Math.max(Math.max(0, -length), Math.min(nextStart - Math.max(0, length), proposed))
    : Math.max(prevEnd, Math.min(nextStart - length, proposed));
  if (!Number.isFinite(start) || !Number.isFinite(start + length)) return null;
  return { start: round(start), end: round(start + length) };
}
