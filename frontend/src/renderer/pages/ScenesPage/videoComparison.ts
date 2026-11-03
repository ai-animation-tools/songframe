import type { DashboardShot } from '@shared/types';

export type VideoComparisonEdit = NonNullable<DashboardShot['asset']>['edit'];

/** Скорость в рецепте бывает десятичной дробью или точным отношением кадров. */
export function parseComparisonSpeed(value: string): number {
  const parts = value.trim().split('/');
  const speed = parts.length === 2 ? Number(parts[0]) / Number(parts[1]) : parts.length === 1 ? Number(parts[0]) : NaN;
  return Number.isFinite(speed) && speed > 0 ? speed : 1;
}

/** Время монтажа переводится в оригинал; конец интервала исключён, удержания показывают крайний кадр. */
export function mapAcceptedTime(edit: VideoComparisonEdit, acceptedTime: number, originalDuration: number, acceptedDuration: number) {
  const speed = parseComparisonSpeed(edit.speed || '1');
  const frame = edit.frames > 0 && edit.duration > 0 ? edit.duration / edit.frames : 1 / 30;
  const duration = Number.isFinite(originalDuration) && originalDuration > 0 ? originalDuration : Infinity;
  const maximum = Math.max(0, duration - frame);
  const start = Math.min(maximum, Math.max(0, edit.sourceInterval?.[0] ?? 0));
  const end = Math.max(start, Math.min(maximum, (edit.sourceInterval?.[1] ?? duration) - frame));
  const holdFirst = Math.max(0, edit.holdFirst || 0);
  const holdLast = Math.max(0, edit.holdLast || 0);
  const total = Number.isFinite(acceptedDuration) && acceptedDuration > 0 ? acceptedDuration : edit.duration;
  const time = Math.max(0, Math.min(acceptedTime, total > 0 ? total : Infinity));
  const movingEnd = total > 0 ? Math.max(holdFirst, total - holdLast) : Infinity;
  const still = edit.stillAt !== null && edit.stillAt !== undefined;
  const sourceTime = still ? Math.min(maximum, Math.max(0, edit.stillAt!)) : Math.min(end, start + Math.max(0, time - holdFirst) * speed);
  const frozen = still || time < holdFirst || time >= movingEnd || sourceTime >= end;
  return { sourceTime: !still && time >= movingEnd ? end : sourceTime, playbackRate: speed, frozen };
}
