import type { ScenarioPass } from '@shared/scenario-workflow';
import { scenarioTexts } from '@shared/texts/scenario';
import type { ScenarioView, ScenesFile } from '@shared/types';

/** База незатронутой вкладки остаётся прежней, чтобы её черновик не потерял признак dirty. */
export function workflowUpdatedView(current: ScenarioView | null, next: ScenarioView, pass: ScenarioPass): ScenarioView {
  if (!current) return next;
  return pass === 'treatment' ? { ...next, scenes: current.scenes } : { ...next, treatment: current.treatment };
}

/**
 * Вид после записи реестра: saveScenes в Go заменяет карту references картой кастинга, поэтому предупреждение
 * об устаревшей карте снимается сразу, без повторного чтения страницы (оно сбросило бы вкладку и выбор плана).
 */
export function scenesSavedView(current: ScenarioView | null, saved: ScenesFile): ScenarioView | null {
  if (!current) return current;
  const problems = current.problems.filter((problem) => problem !== scenarioTexts.main.referencesRefresh);
  return { ...current, scenes: saved, problems, referencesStale: false };
}
