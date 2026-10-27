import type { BriefResult } from '@shared/types';

export interface EntityOption {
  id: string;
  label: string;
}

export type ScenarioBrief = { before: BriefResult; after: BriefResult } | null;
export type ScenarioTab = 'treatment' | 'scenes';
