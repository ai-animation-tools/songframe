/** Частоты кадров проекта: поле fps в plan/project.json, скопированное в реестр plan/scenes.json.
 * Кадровая сетка проекта общая для сценария, принятых клипов и ручного монтажа; @link ../../docs/montage.md.
 */
export const FRAME_RATES = [24, 25, 30] as const;

/** Частота кадров проекта: одно из FRAME_RATES. */
export type FrameRate = (typeof FRAME_RATES)[number];

/** Частота нового проекта по умолчанию и шкала, пока проект не открыт. */
export const DEFAULT_FPS: FrameRate = 30;

/**
 * Допуск границы монтажного участка, секунды: человек вводит секунды кадра до тысячных
 * (кадр 25 при 30 кадрах/с — 0,833). Тот же допуск у Go (cutFrame в internal/production).
 */
export const CUT_TOLERANCE_SECONDS = 0.0005 + 1e-9;

/** Кадр сетки fps для границы участка в секундах или null, если граница между кадрами. */
export function cutFrameOf(seconds: number, fps: number): number | null {
  if (!Number.isFinite(seconds) || seconds < 0) return null;
  const frame = Math.round(seconds * fps);
  return Number.isSafeInteger(frame) && Math.abs(seconds - frame / fps) <= CUT_TOLERANCE_SECONDS ? frame : null;
}

/** Секунды кадра frame до тысячных: так поле участка показывает границу и так её принимает Go. */
export function cutSeconds(frame: number, fps: number): number {
  return Math.round((frame / fps) * 1000) / 1000;
}

/** Половина кадра округляется вверх, как Decimal в build_review, с поправкой на погрешность Number. */
export function secondsToFrames(seconds: number, fps: number): number {
  const scaled = seconds * fps;
  return Math.floor(scaled + 0.5 + Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4);
}
