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

/**
 * Длина принятого участка в кадрах, как её считает Go (build_review): кадры движения —
 * (конец − начало) / скорость с округлением половины вверх, плюс удержания первого и последнего
 * кадра. Скорость — десятичная дробь с точкой или запятой; частное считается точно в целых числах,
 * чтобы граница округления (половина кадра) совпала с Go. null — граница участка не на сетке,
 * скорость не положительная дробь, удержание не целое неотрицательное или движение короче кадра:
 * такой участок Go отклонит сам.
 */
export function cutResultFrames(startFrame: number | null, endFrame: number | null, speed: string, holdFirst = 0, holdLast = 0): number | null {
  if (startFrame === null || endFrame === null || endFrame <= startFrame) return null;
  if (![holdFirst, holdLast].every((hold) => Number.isSafeInteger(hold) && hold >= 0)) return null;
  const match = /^\s*(\d+)(?:[.,](\d*))?\s*$/.exec(speed);
  if (!match) return null;
  const fraction = match[2] ?? '';
  const numerator = BigInt(match[1] + fraction);
  const denominator = 10n ** BigInt(fraction.length);
  if (numerator === 0n) return null;
  // (span · den / num) с округлением половины вверх: ⌊(2 · span · den + num) / (2 · num)⌋.
  const span = BigInt(endFrame - startFrame);
  const motion = (2n * span * denominator + numerator) / (2n * numerator);
  if (motion < 1n) return null;
  return holdFirst + Number(motion) + holdLast;
}

/** Итог подгонки конца участка под окно: кадр конца или почему его не подобрать. */
export type CutEndFit = { endFrame: number; frames: number } | { reason: 'invalid' | 'holdsTooLong' | 'originalTooShort'; neededFrames?: number };

/**
 * Конец участка, при котором план совпадёт с окном: кадры движения (конец − начало) / скорость с
 * округлением половины вверх плюс удержания дают windowFrames (cutResultFrames). Среди концов,
 * дающих окно, выбирается ближайший к windowFrames − удержания × скорость; при скорости меньше 1
 * точного совпадения может не быть — тогда конец даёт ближайшую меньшую длину, недостающее
 * пользователь добирает удержанием (итог участка покажет разницу). Конец не дальше оригинала
 * (originalFrames, если известна длина).
 */
export function fitCutEnd(startFrame: number | null, speed: string, windowFrames: number, holdFirst = 0, holdLast = 0, originalFrames?: number): CutEndFit {
  if (startFrame === null || !Number.isSafeInteger(windowFrames) || windowFrames <= 0) return { reason: 'invalid' };
  if (cutResultFrames(0, 1000, speed, holdFirst, holdLast) === null) return { reason: 'invalid' };
  const motion = windowFrames - holdFirst - holdLast;
  if (motion < 1) return { reason: 'holdsTooLong' };
  const factor = Number(speed.replace(',', '.'));
  const guess = Math.max(1, Math.round(motion * factor));
  // Длина движения не убывает с длиной отрезка: ищем рядом с оценкой самый длинный отрезок не длиннее окна.
  let best: { span: number; frames: number } | null = null;
  for (let span = Math.max(1, guess - 2); span <= guess + 2; span++) {
    const frames = cutResultFrames(0, span, speed, holdFirst, holdLast);
    if (frames === null || frames > windowFrames) continue;
    if (!best || frames > best.frames || (frames === best.frames && Math.abs(span - motion * factor) < Math.abs(best.span - motion * factor))) {
      best = { span, frames };
    }
  }
  if (!best) return { reason: 'invalid' };
  const endFrame = startFrame + best.span;
  if (originalFrames !== undefined && endFrame > originalFrames) return { reason: 'originalTooShort', neededFrames: endFrame };
  return { endFrame, frames: best.frames };
}
