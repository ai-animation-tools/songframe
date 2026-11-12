/** Частоты кадров проекта: поле fps в plan/project.json, скопированное в реестр plan/scenes.json.
 * Кадровая сетка проекта общая для сценария, принятых клипов и ручного монтажа; @link ../../docs/montage.md.
 */
export const FRAME_RATES = [24, 25, 30] as const;

/** Частота кадров проекта: одно из FRAME_RATES. */
export type FrameRate = (typeof FRAME_RATES)[number];

/** Частота нового проекта по умолчанию и шкала, пока проект не открыт. */
export const DEFAULT_FPS: FrameRate = 30;

/** Половина кадра округляется вверх, как Decimal в build_review, с поправкой на погрешность Number. */
export function secondsToFrames(seconds: number, fps: number): number {
  const scaled = seconds * fps;
  return Math.floor(scaled + 0.5 + Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4);
}
