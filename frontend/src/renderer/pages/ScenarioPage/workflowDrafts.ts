import { scenarioTexts } from '@shared/texts/scenario';
import type { ScenarioView, ScenesFile } from '@shared/types';

/**
 * Вид после записи сценария: saveScenes в Go заменяет карту references картой кастинга, поэтому предупреждение
 * об устаревшей карте снимается сразу, без повторного чтения страницы (оно сбросило бы выбор плана).
 */
export function scenesSavedView(current: ScenarioView | null, saved: ScenesFile): ScenarioView | null {
  if (!current) return current;
  const problems = current.problems.filter((problem) => problem !== scenarioTexts.main.referencesRefresh);
  return { ...current, scenes: saved, problems, referencesStale: false };
}
