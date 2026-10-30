/** Предложения сценария используют прежние документы проекта; запись выполняется отдельным подтверждением. */
import type { AgentJob } from './agents';
import type { CastFile, ScenesFile, TreatmentFile } from './types';

export type ScenarioPass = 'treatment' | 'scenes' | 'revise';

export interface ScenarioDocuments {
  cast: CastFile | null;
  treatment: TreatmentFile | null;
  scenes: ScenesFile | null;
}

export interface ScenarioWorkflowStart {
  project: string;
  pass: ScenarioPass;
  note?: string;
  selectedIds?: string[];
}

export interface ScenarioProposal {
  id: string;
  jobId: string;
  pass: ScenarioPass;
  selectedIds: string[];
  /** cancelled: пользователь остановил задание агента; interrupted: задание оборвалось без его решения. */
  status: 'running' | 'ready' | 'invalid' | 'failed' | 'cancelled' | 'interrupted' | 'applied';
  message?: string;
  warnings: string[];
  stale: boolean;
  before: ScenarioDocuments;
  after: ScenarioDocuments;
  changedIds: string[];
}

export interface ScenarioWorkflowView {
  project: string;
  busy: boolean;
  canStartTreatment: boolean;
  canStartScenes: boolean;
  canRevise: boolean;
  canApproveCurrent: boolean;
  canApproveScenes: boolean;
  treatmentApproved: boolean;
  scenesNeedReview: boolean;
  problems: string[];
  proposal: ScenarioProposal | null;
  job: AgentJob | null;
}

/** Перед публикацией проверяются хеши именно файлов, а не только отправленного агенту текста. */
export interface ScenarioPublication {
  project: string;
  pass: ScenarioPass;
  before: ScenarioDocuments;
  after: ScenarioDocuments;
  /** Для source/manifest.json — отпечаток входов без cover/updated_at; для остальных файлов — SHA-256 байтов. */
  expectedHashes: Record<string, string | null>;
}
