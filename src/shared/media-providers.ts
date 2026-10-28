/** Возможности media-провайдеров независимы от текстового агента и не разрешают запуск генерации. */
import type { AgentProvider } from './agent-providers';

export type MediaKind = 'image' | 'video';

/** Реестр провайдеров медиа: общий код и интерфейс узнают о провайдере только отсюда, а не сравнением имён. */
export interface MediaProviderInfo {
  title: string;
  kinds: readonly MediaKind[];
  /** Программа-агент, которую приложение запускает для генерации; null — провайдер вызывается напрямую. */
  executor: AgentProvider | null;
  /** Платный замороженный запрос: цена, баланс и отдельное подтверждение отправки. */
  paid: boolean;
  /** Разрешение, пропорции и число вариантов задаются в настройках проекта. */
  requestParameters: boolean;
  /** Подпись пустой модели в настройках проекта. */
  defaultModelLabel: string;
  /** Что подтверждает и чего не подтверждает проверка возможностей. */
  capabilitiesNote: string;
}

export const MEDIA_PROVIDERS = {
  kling: {
    title: 'Kling',
    kinds: ['image', 'video'],
    executor: null,
    paid: true,
    requestParameters: true,
    defaultModelLabel: 'Автоматически по задаче',
    capabilitiesNote: 'Проверка не запускает генерацию и не тратит кредиты. Подойдёт ли модель для конкретного плана, приложение проверит перед запросом.'
  },
  codex: {
    title: 'Codex',
    kinds: ['image'],
    executor: 'codex',
    paid: false,
    requestParameters: false,
    defaultModelLabel: 'Как указано в настройках Codex',
    capabilitiesNote: 'Проверка не создаёт изображений. Сможет ли Codex их нарисовать, станет ясно при первой генерации.'
  }
} as const satisfies Record<string, MediaProviderInfo>;

export type MediaProviderId = keyof typeof MEDIA_PROVIDERS;
/** Провайдеры, поддерживающие данный вид медиа. */
export type MediaProviderFor<K extends MediaKind> = {
  [P in MediaProviderId]: K extends (typeof MEDIA_PROVIDERS)[P]['kinds'][number] ? P : never;
}[MediaProviderId];

export const MEDIA_PROVIDER_IDS = Object.keys(MEDIA_PROVIDERS) as MediaProviderId[];

export function isMediaProvider<K extends MediaKind>(value: unknown, kind: K): value is MediaProviderFor<K> {
  return (
    typeof value === 'string' &&
    Object.hasOwn(MEDIA_PROVIDERS, value) &&
    (MEDIA_PROVIDERS[value as MediaProviderId].kinds as readonly MediaKind[]).includes(kind)
  );
}

/** Порядок совпадает с порядком вариантов в настройках проекта. */
export function mediaProvidersFor<K extends MediaKind>(kind: K): MediaProviderFor<K>[] {
  return MEDIA_PROVIDER_IDS.filter((id): id is MediaProviderFor<K> => isMediaProvider(id, kind));
}

/** Имя из сохранённого запроса или настроек: регистр и крайние пробелы несущественны. */
export function normalizeMediaProvider(value: unknown): MediaProviderId | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return Object.hasOwn(MEDIA_PROVIDERS, id) ? (id as MediaProviderId) : null;
}

/** Замороженный запрос отправляется и получается только у провайдера с платным исполнителем. */
export function isPaidMediaProvider(value: unknown): boolean {
  const id = normalizeMediaProvider(value);
  return !!id && MEDIA_PROVIDERS[id].paid;
}

/** Названия провайдеров вида медиа для сообщений: «Kling или Codex». */
export function mediaProviderTitles(kind: MediaKind): string {
  return mediaProvidersFor(kind)
    .map((id) => MEDIA_PROVIDERS[id].title)
    .join(' или ');
}

/** Сведения о провайдере из сохранённой строки; неизвестное значение даёт null. */
export function mediaProviderInfo(value: unknown, kind: MediaKind): MediaProviderInfo | null {
  return isMediaProvider(value, kind) ? MEDIA_PROVIDERS[value] : null;
}

/** Имя сервиса в сохранённом запросе и в настройках может отличаться регистром и крайними пробелами. */
export function sameMediaProvider(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string' && !!left.trim() && !!right.trim() && left.trim().toLowerCase() === right.trim().toLowerCase();
}
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
