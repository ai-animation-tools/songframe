/** Предложения сценария строятся по сохранённым документам проекта; запись выполняется отдельным подтверждением. */
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

/** Вид входа утверждения: исходники, разметка песни, кастинг, трактовка. */
export type ScenarioInput = 'sources' | 'timing' | 'cast' | 'treatment';

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
  /** Что изменилось после утверждения, из-за чего сценарий требует пересмотра; пусто — сравнить не с чем. */
  changedInputs: ScenarioInput[];
  /** Принятые в производстве планы с прежней постановкой: их правка закрыта, проходы агента спрашивают подтверждения. */
  acceptedShots: string[];
  problems: string[];
  proposal: ScenarioProposal | null;
  job: AgentJob | null;
}

/** Группа проблемы проверки сценария: состояние героев и мира, сюжет и трактовка, кастинг и референсы, стыки планов. */
export type ScenarioCheckGroup = 'state' | 'story' | 'cast' | 'joins';

/** Важность проблемы: high — испортит видео, medium — заметное расхождение, low — мелочь или сомнение. */
export type ScenarioCheckSeverity = 'high' | 'medium' | 'low';

/** Проблема отчёта проверки: тексты для человека, ID планов реестра и сущностей кастинга. */
export interface ScenarioCheckIssue {
  group: ScenarioCheckGroup;
  severity: ScenarioCheckSeverity;
  shots: string[];
  entities: string[];
  title: string;
  problem: string;
  why: string;
  fix: string;
}

export interface ScenarioCheckReport {
  summary: string;
  issues: ScenarioCheckIssue[];
}

/** Проверка сценария агентом: последний отчёт (plan/scenario-check.json) и доступность новой проверки. */
export interface ScenarioCheckView {
  /** none — проверки ещё не было; cancelled — остановлена пользователем; interrupted — задание оборвалось. */
  status: 'none' | 'running' | 'ready' | 'invalid' | 'failed' | 'cancelled' | 'interrupted';
  canStart: boolean;
  /** Почему новую проверку запустить нельзя. */
  reason: string | null;
  /** Сценарий, кастинг или исходники изменились после проверки. */
  stale: boolean;
  report: ScenarioCheckReport | null;
  message: string | null;
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
