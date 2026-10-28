/** Итог проверки возможностей провайдера для человека: без перечисления технических имён моделей. */
import { mediaProviderInfo, type MediaCapabilities } from '@shared/media-providers';

// Неизвестный провайдер получает общее предупреждение: проверка возможностей не доказывает выполнение генерации.
const DEFAULT_CAPABILITIES_NOTE = 'Проверка не запускает генерацию. Подойдёт ли модель для конкретного плана, приложение проверит перед запросом.';

/** Короткий итог для человека: доступность и число моделей без перечисления технических имён. */
export function capabilitiesSummary(result: MediaCapabilities): string {
  const title = mediaProviderInfo(result.provider, result.kind)?.title ?? result.provider;
  if (!result.available) return `${title} сейчас недоступен.`;
  if (result.problems.length > 0) return `${title} доступен, но часть сведений получить не удалось. Нажмите «Повторить проверку».`;
  // Одна модель может поддерживать несколько команд, поэтому считаем уникальные имена.
  const models = new Set(result.models.map((model) => model.id)).size;
  return models > 0 ? `${title} доступен. Моделей для выбора: ${models}.` : `${title} доступен.`;
}

/** Что проверка подтверждает и чего не подтверждает у этого провайдера. */
export function capabilitiesNote(result: MediaCapabilities): string {
  return mediaProviderInfo(result.provider, result.kind)?.capabilitiesNote ?? DEFAULT_CAPABILITIES_NOTE;
}

/** Повтор проверки нужен только после ошибки, недоступного провайдера или неполного ответа. */
export function capabilitiesFailed(result: MediaCapabilities | null, error: string | null): boolean {
  return !!error || (!!result && (!result.available || result.problems.length > 0));
}
