/** Возможности media-провайдеров независимы от текстового агента и не разрешают запуск генерации. */
export type MediaKind = 'image' | 'video';
/** Обоснование выбора замораживается вместе с запросом и показывается при платном согласовании. */
export interface MediaModelSelection {
  preferredModel: string | null;
  selectedModel: string;
  reason: string;
}
export interface MediaArgument {
  required?: boolean;
  default?: unknown;
  allowed?: string[];
  max_items?: number;
  [key: string]: unknown;
}
export interface MediaModel {
  id: string;
  command: string;
  arguments: Record<string, MediaArgument>;
  slots: Record<string, MediaArgument>;
  limits: Record<string, unknown>;
}
export interface MediaCapabilities {
  provider: string;
  kind: MediaKind;
  available: boolean;
  checkedAt: string;
  models: MediaModel[];
  problems: string[];
  /** Наличие CLI само по себе не доказывает доступность генератора конкретного аккаунта. */
  generationVerified: boolean;
}
export type MediaExecutionRef =
  { provider: 'codex'; kind: 'image'; requestSha: string; agentJobId: string } | { provider: 'kling'; kind: MediaKind; requestSha: string; requestDir: string };
