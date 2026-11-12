/**
 * Необязательное прилипание границы к соседним строкам и плейхеду при перетаскивании на шкале.
 *
 * Прилипание только подсказывает место: оно сдвигает переносимую границу на найденную цель,
 * если та ближе экранного порога, и не запрещает свободные черновики и пересечения.
 */
import type { TimingLine } from '@shared/types';

/** Порог притяжения на экране, px: не зависит от масштаба шкалы. */
export const TIMING_SNAP_PIXELS = 8;

/** Границы остальных строк и плейхед; строки жеста сами себе целью не служат. */
export function timingSnapTargets(lines: TimingLine[], exclude: readonly number[], playhead: number | null): number[] {
  const targets = lines.filter((line) => !exclude.includes(line.id)).flatMap((line) => [line.start, line.end]);
  if (playhead !== null) targets.push(playhead);
  return targets.filter((time) => Number.isFinite(time));
}

/**
 * Ищет ближайшую к одной из переносимых границ цель. edges — времена границ при текущем
 * положении мыши (у переноса строки — начало и конец). Возвращает сдвиг всех границ и
 * время направляющей либо null, если ни одна цель не ближе порога.
 */
export function timingSnap(edges: readonly number[], targets: readonly number[], pps: number): { shift: number; guide: number } | null {
  if (!Number.isFinite(pps) || pps <= 0) return null;
  const tolerance = TIMING_SNAP_PIXELS / pps;
  let best: { shift: number; guide: number } | null = null;
  for (const edge of edges) {
    if (!Number.isFinite(edge)) continue;
    for (const target of targets) {
      const shift = target - edge;
      if (Math.abs(shift) <= tolerance && (!best || Math.abs(shift) < Math.abs(best.shift))) best = { shift, guide: target };
    }
  }
  return best;
}
