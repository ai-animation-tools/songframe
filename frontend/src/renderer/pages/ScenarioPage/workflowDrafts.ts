import type { ScenarioPass } from '@shared/scenario-workflow';
import type { ScenarioView } from '@shared/types';

/** База незатронутой вкладки остаётся прежней, чтобы её черновик не потерял признак dirty. */
export function workflowUpdatedView(current: ScenarioView | null, next: ScenarioView, pass: ScenarioPass): ScenarioView {
  if (!current) return next;
  return pass === 'treatment' ? { ...next, scenes: current.scenes } : { ...next, treatment: current.treatment };
}
