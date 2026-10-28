/** Таблица адаптеров провайдеров медиа — единственная точка регистрации: удаление провайдера = удаление строки и папки адаптера. */
import type { MediaProviderId } from '@shared/media-providers';
import { codex } from './codex';
import { kling } from './kling';
import type { AgentProviderAdapter, MediaProviderAdapter, PaidProviderAdapter } from './types';

const MEDIA_ADAPTERS: Record<MediaProviderId, MediaProviderAdapter> = { kling, codex };

/** Адаптер платного провайдера по id из реестра; регистр и крайние пробелы несущественны. */
export function paidAdapter(provider: unknown): PaidProviderAdapter | null {
  if (typeof provider !== 'string') return null;
  const id = provider.trim().toLowerCase();
  const adapter = Object.hasOwn(MEDIA_ADAPTERS, id) ? MEDIA_ADAPTERS[id] : null;
  return adapter?.type === 'paid' ? adapter : null;
}

/** Все платные провайдеры в порядке таблицы. */
export function paidAdapters(): PaidProviderAdapter[] {
  return Object.values(MEDIA_ADAPTERS).filter((adapter): adapter is PaidProviderAdapter => adapter.type === 'paid');
}

/** Адаптер провайдера-агента по id из реестра; регистр и крайние пробелы несущественны. */
export function agentAdapter(provider: unknown): AgentProviderAdapter | null {
  if (typeof provider !== 'string') return null;
  const id = provider.trim().toLowerCase();
  const adapter = Object.hasOwn(MEDIA_ADAPTERS, id) ? MEDIA_ADAPTERS[id] : null;
  return adapter?.type === 'agent' ? adapter : null;
}

/** Провайдеры, генерацию которых исполняет программа-агент, в порядке таблицы. */
export function agentAdapters(): AgentProviderAdapter[] {
  return Object.values(MEDIA_ADAPTERS).filter((adapter): adapter is AgentProviderAdapter => adapter.type === 'agent');
}

/** Тестовая регистрация адаптера (например, провайдера `test`); возвращает откат. */
export function registerMediaAdapterForTests(adapter: MediaProviderAdapter): () => void {
  const previous = Object.hasOwn(MEDIA_ADAPTERS, adapter.id) ? MEDIA_ADAPTERS[adapter.id] : undefined;
  MEDIA_ADAPTERS[adapter.id] = adapter;
  return () => {
    if (previous) MEDIA_ADAPTERS[adapter.id] = previous;
    else delete MEDIA_ADAPTERS[adapter.id];
  };
}

export type {
  AgentCoverDeps,
  AgentImageDeps,
  AgentImageExecutor,
  AgentProviderAdapter,
  MediaProviderAdapter,
  PaidProviderAdapter,
  PaidRequestRules
} from './types';
