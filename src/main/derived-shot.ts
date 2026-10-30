/** Производный план определяется только сценарием; происхождение старого комплекта не блокирует новое производство. */
const SHOT_ID = /^M\d{2}(?:\.\d+)?$/;
const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);

/** Исторический generation.source_shot описывает сохранённый материал, а выбор источника принадлежит derived_from. */
export function derivedShotSource(_project: string, scene: unknown): string | null {
  if (!record(scene) || typeof scene.id !== 'string' || !record(scene.derived_from)) return null;
  const source = scene.derived_from.shot;
  return typeof source === 'string' && SHOT_ID.test(source) && source !== scene.id ? source : null;
}
