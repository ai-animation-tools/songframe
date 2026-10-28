import type { MediaProviderFor } from './media-providers';

/** Без выбранного агента недоступны текстовые этапы; генерация медиа от агента не зависит. */
export const COVER_AGENT_REQUIRED = 'Сначала выберите агента в настройках приложения.';

/** Временная сессия обложки не меняет исходники до сохранения общей формы. */
export interface CoverCrop {
  x: number;
  y: number;
  size: number;
}

export interface CoverGenerationSession {
  id: string;
  prompt: string;
  status: 'idle' | 'generating' | 'ready' | 'failed' | 'accepted';
  image: { path: string; width: number; height: number } | null;
  error: string | null;
  provider: MediaProviderFor<'image'>;
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
