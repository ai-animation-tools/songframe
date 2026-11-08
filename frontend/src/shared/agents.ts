import type { AgentProvider } from './agent-providers';

/** Глобальный выбор агента не связан с видеопровайдером проекта и не содержит учётных данных. */
/** CLI всегда находится автоматическим поиском; найденный файл виден в результате проверки. */
export interface AgentSettings {
  provider: AgentProvider;
  model?: string;
}

/** Модель из каталога CLI: id передаётся в --model, подпись показывается в настройках. */
export interface AgentModel {
  id: string;
  label: string;
  description?: string;
  isDefault?: boolean;
}

/** Пустой список с сообщением означает, что каталог недоступен и модель можно ввести вручную. */
export interface AgentModelsResult {
  models: AgentModel[];
  message?: string;
}

export interface AgentCheckResult {
  executablePath?: string;
  version?: string;
  availability: 'available' | 'not_found' | 'error';
  authorization: 'authenticated' | 'unauthenticated' | 'unknown';
  message: string;
}

/** Снимок штатной диагностики аккаунта; null означает, что CLI не подтвердил показатель. */
export interface AgentAccountLimit {
  label: string;
  usedPercent: number;
  windowMinutes: number | null;
  resetsAt: number | null;
}

export interface AgentAccountResult {
  provider: AgentSettings['provider'];
  checkedAt: string;
  diagnostic: AgentCheckResult;
  email: string | null;
  organization: string | null;
  authenticationMethod: string | null;
  plan: string | null;
  subscriptionStatus: string | null;
  subscriptionExpiresAt: string | null;
  limits: AgentAccountLimit[] | null;
  /** Ограничение использования показывается только по явному признаку провайдера. */
  usageAllowed?: boolean | null;
  credits: string | null;
  message?: string;
}

/** Рабочие задания пока готовят предложения; применение файлов принадлежит отдельному согласованию. */
export interface AgentStartInput {
  project: string;
  task: string;
  prompt: string;
  context?: string;
  /** Локальные PNG/JPEG передаются модели как вложения только в заданиях без записи. */
  images?: string[];
  retryOf?: string;
}

export type AgentDiagnosticCode =
  | 'INVALID_INPUT'
  | 'PROJECT_BUSY'
  | 'CLI_NOT_FOUND'
  | 'CLI_UNAVAILABLE'
  | 'AUTH_REQUIRED'
  | 'AUTH_UNKNOWN'
  | 'UNSUPPORTED_VERSION'
  | 'PROTOCOL_ERROR'
  | 'OUTPUT_LIMIT'
  | 'TIMEOUT'
  | 'CANCELLED'
  | 'INTERRUPTED'
  | 'CLI_ERROR'
  | 'RATE_LIMIT';

export interface AgentJob {
  schemaVersion: 1;
  id: string;
  sequence: number;
  project: string;
  provider: AgentSettings['provider'];
  task: string;
  model?: string;
  cliVersion?: string;
  retryOf?: string;
  permissions: 'read-only' | 'workspace-write';
  inputHashes: { prompt: string; context: string };
  status: 'running' | 'completed' | 'failed' | 'cancelled' | 'interrupted';
  phase: string;
  startedAt: string;
  finishedAt: string | null;
  exitCode: number | null;
  sessionId?: string;
  diagnostic?: AgentDiagnosticCode;
  message?: string;
  result: string;
  log: string;
}

export interface AgentEvent {
  jobId: string;
  project: string;
  sequence: number;
  phase: string;
  type: 'started' | 'text_delta' | 'tool_started' | 'tool_finished' | 'completed' | 'failed';
  text?: string;
  tool?: string;
  /** Снимок нужен для начала/завершения; текстовые события передают только приращение. */
  job?: AgentJob;
}
