/** Кадровая сетка приложения общая для сценария, принятых клипов и ручного монтажа.
 * Форматы scenes/manifest и Python-сборщики пока поддерживают только эту частоту; @link ../../docs/montage.md.
 */
export const FPS = 30;

/** Половина кадра округляется вверх, как Decimal в build_review, с поправкой на погрешность Number. */
export function secondsToFrames(seconds: number): number {
  const scaled = seconds * FPS;
  return Math.floor(scaled + 0.5 + Number.EPSILON * Math.max(1, Math.abs(scaled)) * 4);
}
