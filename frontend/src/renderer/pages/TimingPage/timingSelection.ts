import type { TimingLine } from '@shared/types';
import { MIN_LENGTH, round } from './timing';
import { timingPlaybackBounds } from './timingPlayback';

export interface TimingBounds {
  start: number;
  end: number;
}

export interface TimingPair {
  first: TimingLine;
  second: TimingLine;
  join: number | null;
  gap: number;
  locked: boolean;
}

/** Соседство считается по полному черновику, а не по порядку текста или текущему фильтру.
 * Некорректные интервалы остаются в редакторе, но не становятся парой для прослушивания и стыка. */
export function timingPair(lines: TimingLine[], ids: readonly number[]): TimingPair | null {
  if (ids.length !== 2 || ids[0] === ids[1]) return null;
  const playable = lines.filter((line) => timingPlaybackBounds(line, 0)).sort((a, b) => a.start - b.start || a.id - b.id);
  const selected = playable.filter((line) => ids.includes(line.id));
  if (selected.length !== 2 || selected[0].id === selected[1].id) return null;
  const [first, second] = selected;
  if (playable.indexOf(second) !== playable.indexOf(first) + 1) return null;
  const gap = second.start - first.end;
  // Допуск компенсирует погрешность миллисекундных границ; чтение само ничего не склеивает.
  const join = Math.abs(gap) <= 0.001 + Number.EPSILON * Math.max(1, Math.abs(second.start), Math.abs(first.end)) ? first.end + gap / 2 : null;
  return { first, second, join, gap, locked: Boolean(first.verified || second.verified) };
}

/** Общая граница меняет только внутренние края; разрыв или перекрытие исчезает лишь по явному действию.
 * Миллисекундная сетка округляется внутрь допустимого диапазона, сохраняя минимальную длину обеих строк. */
export function timingPairPatch(pair: TimingPair, time: number, duration: number): { id: number; patch: Partial<TimingLine> }[] | null {
  const { first, second } = pair;
  if (pair.locked || first.verified || second.verified || first.id === second.id || !Number.isFinite(time)) return null;
  if (!timingPlaybackBounds(first, duration) || !timingPlaybackBounds(second, duration)) return null;
  const lower = Math.ceil((first.start + MIN_LENGTH) * 1000 - 1e-9) / 1000;
  const upper = Math.floor((second.end - MIN_LENGTH) * 1000 + 1e-9) / 1000;
  if (lower > upper) return null;
  const join = Math.max(lower, Math.min(upper, round(time)));
  return [
    { id: first.id, patch: { end: join } },
    { id: second.id, patch: { start: join } }
  ];
}

/** Воспроизведение выделения включает промежуток между строками и не исправляет их исходные данные. */
export function timingSelectionBounds(lines: TimingLine[], ids: readonly number[], duration: number): TimingBounds | null {
  if (ids.length < 1 || ids.length > 2 || new Set(ids).size !== ids.length) return null;
  const bounds = ids.map((id) =>
    timingPlaybackBounds(
      lines.find((line) => line.id === id),
      duration
    )
  );
  if (bounds.some((bound) => !bound)) return null;
  const valid = bounds.filter((bound): bound is TimingBounds => bound !== null);
  return { start: Math.min(...valid.map((bound) => bound.start)), end: Math.max(...valid.map((bound) => bound.end)) };
}

/** Окно стыка доступно только у соприкасающейся пары, включая закреплённые строки. */
export function timingJoinBounds(pair: TimingPair, duration: number, padding = 0.7): TimingBounds | null {
  if (pair.join === null || !Number.isFinite(pair.join) || !Number.isFinite(padding) || padding <= 0) return null;
  if (!timingPlaybackBounds(pair.first, duration) || !timingPlaybackBounds(pair.second, duration)) return null;
  const start = Math.max(0, pair.join - padding);
  const end = duration > 0 ? Math.min(duration, pair.join + padding) : pair.join + padding;
  return end > start ? { start, end } : null;
}

/** Масштаб помещает весь диапазон с десятипроцентными полями и учитывает края трека.
 * Нижнего фиксированного масштаба нет: длинный трек тоже должен целиком помещаться в окно. */
export function timingZoomBounds(bounds: TimingBounds, viewportWidth: number, duration: number): { pps: number; scrollLeft: number } | null {
  if (!Number.isFinite(viewportWidth) || viewportWidth <= 0 || !Number.isFinite(duration) || duration <= 0) return null;
  if (!Number.isFinite(bounds.start) || !Number.isFinite(bounds.end) || bounds.start < 0 || bounds.end <= bounds.start || bounds.end > duration) return null;
  const padding = (bounds.end - bounds.start) * 0.1;
  const start = Math.max(0, bounds.start - padding);
  const end = Math.min(duration, bounds.end + padding);
  const pps = Math.min(400, viewportWidth / (end - start));
  const scrollLeft = Math.max(0, Math.min(start * pps, duration * pps - viewportWidth));
  return { pps, scrollLeft };
}
