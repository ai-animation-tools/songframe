import { aiAccessTexts } from './texts/ai-access';
import type { MediaProviderId } from './media-providers';

/** Без выбранного агента недоступны текстовые этапы; генерация медиа от агента не зависит. */
export const COVER_AGENT_REQUIRED = aiAccessTexts.agentRequired;

/** Копия опоры, зафиксированная для согласованного запроса изображения. */
export interface GenerationReferenceImage {
  path: string;
  label: string;
  sha256: string;
  bytes: number;
}

/** Временная сессия обложки не меняет исходники до сохранения общей формы. */
export interface CoverCrop {
  x: number;
  y: number;
  size: number;
}

export interface CoverGenerationSession {
  id: string;
  prompt: string;
  /** Референсы объекта в сессии референса; обложка не получает их автоматически. */
  referenceImages?: GenerationReferenceImage[];
  status: 'idle' | 'generating' | 'ready' | 'failed' | 'accepted';
  image: { path: string; width: number; height: number } | null;
  error: string | null;
  provider: MediaProviderId;
  model: string | null;
  preparing: boolean;
  requestSha: string | null;
  /** Новый токен для каждой подготовки: SHA одинакового промпта может совпасть в разных попытках. */
  approvalToken: string | null;
  quote: {
    credits: number | null;
    balance: number | null;
    verdict: 'ok' | 'insufficient_balance' | 'cost_or_balance_unknown';
    message?: string;
  } | null;
}

export interface CoverGenerationApproval {
  approvalToken: string;
  promptConfirmed: true;
  allowUnknownCost?: boolean;
}

export interface CoverGenerationApi {
  create(project: string, prompt: string): Promise<CoverGenerationSession>;
  /** Подготовка следующей попытки и цены не отправляет запрос генерации. */
  prepare(id: string): Promise<CoverGenerationSession>;
  generate(id: string, requestSha: string, approval: CoverGenerationApproval): Promise<CoverGenerationSession>;
  view(id: string): Promise<CoverGenerationSession>;
  /** Только выбранная квадратная область остаётся во временной сессии для сохранения формы. */
  accept(id: string, crop: CoverCrop): Promise<{ id: string; path: string }>;
  close(id: string): Promise<void>;
}
