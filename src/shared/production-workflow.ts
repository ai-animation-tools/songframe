/** Предметные задания производства; вопросы и решения по-прежнему принадлежат workflow.json пакета. */
import type { AgentJob } from './agents';

export type ProductionPass = 'description' | 'frames' | 'prompt' | 'request';
export interface ProductionFramePrompt {
  id: string;
  role: 'first' | 'middle' | 'last';
  timeSeconds: number;
  prompt: string;
  referencePaths: string[];
}
export interface ProductionFrameCandidate {
  id: string;
  path: string;
}
export interface ProductionRequestDraft {
  model: string;
  /** Команда и флаги входов — из объявленных возможностей провайдера видео; `input` со `slot` задаёт именованный слот. */
  command: string;
  parameters: Record<string, unknown>;
  inputs: { flag: string; slot?: string; path: string; role?: string }[];
  outputs: number;
}
export type ProductionStageProposal =
  | { schemaVersion: 1; stage: 'description'; description: string; requestSeconds: number; keyframes: ProductionFramePrompt[] }
  | { schemaVersion: 1; stage: 'frames'; images: ProductionFrameCandidate[] }
  | { schemaVersion: 1; stage: 'prompt'; prompt: string }
  | { schemaVersion: 1; stage: 'request'; request: ProductionRequestDraft };
export interface ProductionProposal {
  id: string;
  jobId: string;
  stage: ProductionPass;
  status: 'running' | 'ready' | 'invalid' | 'failed' | 'interrupted' | 'applied';
  stale: boolean;
  message?: string;
  /** Текст ответа агента, не прошедшего проверку: показывается вместо предложения вместе с причиной. */
  agentText?: string;
  before: string;
  after: ProductionStageProposal | null;
}
export interface ProductionWorkflowStart {
  project: string;
  shot: string;
  packageDir?: string;
  action: 'prepare' | 'revise' | 'continue';
  note?: string;
  stage?: Exclude<ProductionPass, 'frames'>;
}
export interface ProductionWorkflowView {
  project: string;
  shot: string;
  packageDir: string | null;
  busy: boolean;
  stage: string | null;
  canPrepare: boolean;
  canContinue: boolean;
  canRevise: boolean;
  canGenerateFrames: boolean;
  /** Попытка пакета уже оплачена: подготовка продолжается только новой попыткой или возвратом с замечанием. */
  paid: boolean;
  /** Почему действие подготовки недоступно; пусто, когда оно доступно. */
  reasons: { prepare: string | null; continue: string | null; frames: string | null };
  /** План собирается из материала другого плана (derived_from или комплект derived_video): подготовка и генерация заблокированы. */
  derivedFrom: string | null;
  /** Backend опор выбран в проекте независимо от текстового агента. */
  imageProvider?: string;
  /** Провайдер видео проекта: по нему интерфейс подписывает команды черновика запроса. */
  videoProvider?: string;
  framePrompts: ProductionFramePrompt[];
  problems: string[];
  proposal: ProductionProposal | null;
  job: AgentJob | null;
}
export interface ProductionImagesInput {
  project: string;
  shot: string;
  packageDir: string;
  frames: ProductionFramePrompt[];
}

/** Причина блокировки подготовки и повтора для плана, который собирается из материала другого плана. */
export function derivedShotReason(source: string): string {
  return `План собирается из материала ${source}: описание, опоры и генерация для него не нужны.`;
}
