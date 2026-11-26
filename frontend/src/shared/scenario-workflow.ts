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
  /** Номер проблемы отчёта проверки, из которой запущена доработка: применённое предложение отметит её исправленной. */
  checkIssue?: number;
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

/** Вид входа утверждения: исходники, разметка песни, кастинг, части сценария. */
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

/** Группа проблемы проверки сценария: состояние героев и мира, сюжет и части, кастинг и референсы, стыки планов. */
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
  /** Правки состояния, которые приложение вносит само по «Исправить»; пусто — нужна доработка плана. */
  changes: ScenarioCheckChange[];
  /** Правки проблемы внесены приложением или применённой доработкой, запущенной из неё. */
  fixed: boolean;
  /** Пользователь отметил проблему решённой сам: исправил вручную или решил не исправлять. */
  resolved: boolean;
}

/** Правка состояния: свойству сущности в первом (before) или последнем (after) кадре плана — новое значение; null убирает его. */
export interface ScenarioCheckChange {
  shot: string;
  phase: 'before' | 'after';
  entity: string;
  property: string;
  value: string | null;
}

/** Правка в предпросмотре: подписи по текущему кастингу, текущее и новое значение. */
export interface ScenarioCheckFixChange extends ScenarioCheckChange {
  /** Номер проблемы в отчёте с 0. */
  issue: number;
  entityName: string;
  propertyLabel: string;
  current: string | null;
}

/** Что изменят правки выбранных проблем: задетые принятые планы (direct — правка в самом плане) и прочие планы с начатым производством. */
export interface ScenarioCheckFixPreview {
  changes: ScenarioCheckFixChange[];
  accepted: { id: string; direct: boolean }[];
  stale: string[];
}

/** Отметка «Решено вручную» у проблемы отчёта; resolved=false снимает её. */
export interface ScenarioCheckResolveInput {
  project: string;
  issue: number;
  resolved: boolean;
}

/** Применение правок: проблемы по номерам отчёта и принятые планы, которые остаются принятыми. */
export interface ScenarioCheckFixInput {
  project: string;
  issues: number[];
  keep: string[];
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

/** Пункт рекомендаций по референсам: entity — ID кастинга или '' для того, чего в кастинге ещё нет. */
export interface ReferenceAdviceItem {
  entity: string;
  name: string;
  need: string;
  views: string[];
  count: number;
  states: string[];
  why: string;
  have: string;
}

export interface ReferenceAdviceReport {
  summary: string;
  items: ReferenceAdviceItem[];
}

/** Рекомендации агента по референсам: те же состояния, что у проверки сценария; preliminary — совет без сценария. */
export interface ReferenceAdviceView {
  status: ScenarioCheckView['status'];
  canStart: boolean;
  reason: string | null;
  preliminary: boolean;
  /** Исходники, кастинг или сценарий изменились после совета. */
  stale: boolean;
  report: ReferenceAdviceReport | null;
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
