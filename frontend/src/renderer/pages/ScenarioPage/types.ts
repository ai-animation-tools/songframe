import { scenarioTexts } from '@shared/texts/scenario';
import type { BriefResult, ScenarioImpactShot, ScenesFile, ScenesSaveMode } from '@shared/types';

export interface EntityOption {
  id: string;
  label: string;
}

export type ScenarioBrief = { before: BriefResult; after: BriefResult } | null;
export type ScenarioTab = 'treatment' | 'scenes';

/** План, к которому нужно прокрутить реестр: к редактору постановки (переход с другой страницы) или к блоку состояния (источник значения врезки). */
export interface ShotReveal {
  shot: string;
  target: 'shot' | 'state';
  /** Сущность и блок состояния, которые раскрываются при переходе из врезки. */
  entity?: string;
  phase?: 'before' | 'after';
}

/** Переход из врезки к месту правки значения: план, сущность и блок состояния. */
export type OpenShotState = (shot: string, entity?: string, phase?: 'before' | 'after') => void;

/** Якорь списка проблем реестра: чип панели прокручивает к нему. */
export const SCENE_PROBLEMS_ID = 'scenario-scene-problems';

/** Сохранение реестра, ждущее подтверждения: черновик и затронутые планы на момент расчёта. */
export interface ScenesSaveRequest {
  mode: ScenesSaveMode;
  scenes: ScenesFile;
  shots: ScenarioImpactShot[];
}

/** Причина недоступности «Сохранить без производства»: черновик не затрагивает планы с материалами. */
export const KEEP_NOTHING_REASON = scenarioTexts.save.keepNothingReason;
