import type { BriefResult } from '@shared/types';

export interface EntityOption {
  id: string;
  label: string;
}

export type ScenarioBrief = { before: BriefResult; after: BriefResult } | null;
export type ScenarioTab = 'treatment' | 'scenes';

/** Якорь списка проблем реестра: чип панели прокручивает к нему. */
export const SCENE_PROBLEMS_ID = 'scenario-scene-problems';
