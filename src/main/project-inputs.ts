/** Значимые поля проекта для производных представлений; контракт совпадает с tools/project_inputs.py. */
export interface CardsProjectInputs {
  name: string;
}
export interface AnimaticProjectInputs extends CardsProjectInputs {
  animatic_video: string;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function cardsProjectInputs(project: unknown): CardsProjectInputs | null {
  return record(project) && typeof project.name === 'string' ? { name: project.name } : null;
}

export function animaticProjectInputs(project: unknown): AnimaticProjectInputs | null {
  const cards = cardsProjectInputs(project);
  return cards && record(project) && typeof project.animatic_video === 'string' ? { ...cards, animatic_video: project.animatic_video } : null;
}

/** Снимок имеет единственный формат: неизвестные ключи или неверные типы требуют обновления производного файла. */
function matches(snapshot: unknown, current: CardsProjectInputs | AnimaticProjectInputs | null): boolean {
  if (!current || !record(snapshot)) return false;
  const expected = Object.entries(current);
  return Object.keys(snapshot).length === expected.length && expected.every(([key, value]) => typeof snapshot[key] === 'string' && snapshot[key] === value);
}

export function cardsProjectInputsMatch(snapshot: unknown, project: unknown): boolean {
  return matches(snapshot, cardsProjectInputs(project));
}

export function animaticProjectInputsMatch(snapshot: unknown, project: unknown): boolean {
  return matches(snapshot, animaticProjectInputs(project));
}
