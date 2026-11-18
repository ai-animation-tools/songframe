import { productionTexts } from './texts/production';
/** Предметные задания производства; вопросы и решения принадлежат workflow.json пакета. */
import type { AgentJob } from './agents';

export type ProductionPass = 'description' | 'frames' | 'prompt' | 'request';
export interface ProductionFramePrompt {
  id: string;
  role: 'first' | 'middle' | 'last';
  timeSeconds: number;
  prompt: string;
  referencePaths: string[];
  /**
   * Опора повторяет кадр в кадр более раннюю опору (её ID) или кадр принятого плана (путь `<пакет>/continuity/M09-last.png`):
   * промпт пуст, файл приходит копией источника — после утверждения опоры или описания.
   */
  copyOf?: string;
}
/** Кадр принятого плана, которому копия опоры равна кадр в кадр; null — источник копии другая опора. */
export function copyShotFrame(copyOf: string): { shot: string; position: 'first' | 'last' } | null {
  const match = /(?:^|\/)continuity\/(M\d{2}(?:\.\d+)?)-(first|last)\.png$/.exec(copyOf);
  return match ? { shot: match[1], position: match[2] as 'first' | 'last' } : null;
}
/**
 * Свой текст этапа без агента: описание с планом опор или видеопромпт. Go проверяет его теми же правилами, что ответ агента,
 * и применяет к попытке; packageDir не задан — новая попытка с описанием.
 */
export type ProductionOwnInput = { project: string; shot: string; packageDir?: string } & ProductionOwnText;
/** Свой текст этапа: описание с планом опор или видеопромпт. */
export type ProductionOwnText =
  { stage: 'description'; description: string; requestSeconds: number; keyframes: ProductionFramePrompt[] } | { stage: 'prompt'; prompt: string };
export interface ProductionFrameCandidate {
  id: string;
  path: string;
}
/**
 * Изменение подготовленного запроса на вопросе «Отправить»: модель и значения её выбираемых параметров
 * (из ProductionRequestOptions). Go собирает запрос заново, длительность и входы остаются по плану.
 */
export interface ProductionRequestChange {
  model: string;
  parameters: Record<string, unknown>;
}
/**
 * Модели команды видео провайдера и параметры, которые пользователь выбирает сам, с текущим запросом попытки.
 * unavailable — почему модель не примет план (опоры, длительность, срез речи, настройки проекта): в окне она выключена.
 */
export interface ProductionRequestOptions {
  models: { id: string; parameters: { name: string; values: unknown[] }[]; unavailable?: string }[];
  /** Модель и выбираемые параметры текущего запроса попытки. */
  model: string;
  parameters: Record<string, unknown>;
}
export type ProductionStageProposal =
  | { schemaVersion: 1; stage: 'description'; description: string; requestSeconds: number; keyframes: ProductionFramePrompt[] }
  | { schemaVersion: 1; stage: 'frames'; images: ProductionFrameCandidate[] }
  /** prompt — на языке провайдера видео; translation — тот же промпт по-русски, если агент его предложил. */
  | { schemaVersion: 1; stage: 'prompt'; prompt: string; translation?: string };
/**
 * Противоречие сценария из отказа агента. Поле состояния: кадр, сущность и свойство с текущим значением и его источником
 * (source.shot null — начальное состояние кастинга) и предложенным значением fix (null — не исправляется в этом плане).
 * Поле постановки (field) только объясняется.
 */
export type ProductionScenarioProblem =
  | {
      phase: 'before' | 'after';
      entity: string;
      entityName: string;
      property: string;
      propertyLabel: string;
      current: string | null;
      source: { shot: string | null; phase: 'before' | 'after' | null } | null;
      conflict: string;
      fix: string | null;
    }
  | { field: 'action' | 'camera' | 'continuity' | 'references'; conflict: string };
export interface ProductionProposal {
  id: string;
  jobId: string;
  stage: ProductionPass;
  /** cancelled: пользователь остановил задание агента; interrupted: задание оборвалось без его решения. */
  status: 'running' | 'ready' | 'invalid' | 'failed' | 'cancelled' | 'interrupted' | 'applied';
  stale: boolean;
  message?: string;
  /** Текст ответа агента, не прошедшего проверку: показывается вместо предложения вместе с причиной. */
  agentText?: string;
  /** Агент отказался по скиллу (текстом или списком противоречий), а не ошибся форматом; причина в agentText. */
  refused?: boolean;
  /** Противоречия сценария из отказа описания: таблица «было → станет»; исправления вносит fixScenario. */
  problems?: ProductionScenarioProblem[];
  before: string;
  after: ProductionStageProposal | null;
}
export interface ProductionWorkflowStart {
  project: string;
  shot: string;
  packageDir?: string;
  action: 'prepare' | 'revise' | 'continue';
  note?: string;
  /** Явный этап доработки; запрос видео агент не готовит — его собирает prepareRequest. */
  stage?: 'description' | 'prompt';
  /** Число опор описания, выбранное пользователем (1…keyframeLimit); 0 — «авто», без поля при доработке — прежний выбор попытки. */
  keyframes?: number;
}
/** Способ генерации видео попытки: провайдер проекта или вручную вне приложения. */
export type ProductionGenerationMethod = 'provider' | 'manual';

export interface ProductionWorkflowView {
  project: string;
  shot: string;
  packageDir: string | null;
  busy: boolean;
  stage: string | null;
  /** Следующий проход по попытке: им интерфейс называет следующее действие; request собирает приложение без агента. */
  nextStage?: ProductionPass | null;
  /** Опора открытого вопроса: её кандидата можно заменить своим файлом без замечания. */
  replaceFrame?: string | null;
  canPrepare: boolean;
  canContinue: boolean;
  canRevise: boolean;
  /** Этап, который переделает доработка, пока она доступна (canRevise): в его шаге пути она показывается и по нему называется. */
  reviseStage?: Exclude<ProductionPass, 'request'> | null;
  canGenerateFrames: boolean;
  /** Попытка пакета уже оплачена: подготовка продолжается только новой попыткой или возвратом с замечанием. */
  paid: boolean;
  /** Почему действие подготовки недоступно; пусто, когда оно доступно. */
  reasons: { prepare: string | null; continue: string | null; frames: string | null; manual?: string | null };
  /** Видео создаётся вне приложения по пакету ручной генерации: речевой план без липсинка (singleFrame) или выбранный способ попытки. */
  manual?: boolean;
  /** Речевой план у провайдера без липсинка: всегда вручную и по одной опоре K01. */
  singleFrame?: boolean;
  /** Способ генерации, выбранный для попытки; нет — видео делает провайдер проекта. */
  generationMethod?: 'manual';
  /** Пакет ручной генерации можно собрать сейчас; причина недоступности — reasons.manual. */
  canBuildManual?: boolean;
  /** Предел длины видеопромпта провайдера в символах: длиннее него промпт не утверждается; нет — предела нет (в том числе у ручной генерации). */
  promptMaxChars?: number;
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
  return productionTexts.workflow.derived({ source });
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
  if (proposal.stale) return productionTexts.workflow.stale;
  if (proposal.status === 'ready') return productionTexts.workflow.ready;
  if (proposal.status === 'invalid') return productionTexts.workflow.invalid;
  return productionTexts.workflow.failed;
}
