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
  command: 'text_to_video' | 'image_to_video' | 'omni_ref_video' | 'motion_control';
  parameters: Record<string, unknown>;
  inputs: { flag: 'input' | 'image' | 'tailImage' | 'audio' | 'video'; slot?: string; path: string; role?: string }[];
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
  managed: boolean;
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
  /** Backend опор выбран в проекте независимо от текстового агента. */
  imageProvider?: string;
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
