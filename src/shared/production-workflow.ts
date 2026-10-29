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
  /** Агент ответил текстом вместо JSON — штатный отказ по скиллу, а не ошибка формата; причина в agentText. */
  refused?: boolean;
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
  /** Опора, которую создаст следующее задание: опоры генерируются и согласуются по одной. */
  nextFrame: string | null;
  /** Утверждённые опоры пакета: для них импорт своих файлов недоступен до возврата на доработку. */
  approvedFrameIds: string[];
  problems: string[];
  proposal: ProductionProposal | null;
  job: AgentJob | null;
}
export interface ProductionImagesInput {
  project: string;
  shot: string;
  packageDir: string;
  frames: ProductionFramePrompt[];
  /** Действующие замечания пользователя к создаваемой опоре. */
  notes?: string[];
  /** Утверждённые опоры пакета: референсы согласованности следующих кадров (абсолютные пути). */
  approvedFrames?: { id: string; role: ProductionFramePrompt['role']; path: string }[];
}

/** Причина блокировки подготовки и повтора для плана, который собирается из материала другого плана. */
export function derivedShotReason(source: string): string {
  return `План собирается из материала ${source}: описание, опоры и генерация для него не нужны.`;
}

/** Предложение агента, которое ещё ждёт решения: отметка плана в списке «Производства». */
export interface ProductionProposalSummary {
  stage: ProductionPass;
  status: 'ready' | 'invalid' | 'failed';
  stale: boolean;
  /** Пакет предложения; null — новая подготовка. */
  packageDir: string | null;
}

/** Что сказать о непринятом предложении в списке планов: по этому тексту план попадает в «Ждут вашего действия». */
export function proposalAttention(proposal: ProductionProposalSummary): string {
  if (proposal.stale) return 'предложение агента устарело: отклоните его или подготовьте заново';
  if (proposal.status === 'ready') return 'предложение агента ждёт применения или отклонения';
  if (proposal.status === 'invalid') return 'ответ агента не прошёл проверку: просмотрите и отклоните';
  return 'задание агента завершилось ошибкой: просмотрите и отклоните';
}
