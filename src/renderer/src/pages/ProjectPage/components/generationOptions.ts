/** Каталог задаёт провайдер; порядок известных моделей в интерфейсе — из реестра провайдеров. */
import { mediaProviderInfo, type MediaModel } from '@shared/media-providers';

const alphabetical = (a: string, b: string): number => a.localeCompare(b, 'en', { numeric: true });

export function modelOptions(models: readonly MediaModel[], kind: 'image' | 'video', provider: unknown): string[] {
  const order = mediaProviderInfo(provider, kind)?.modelOrder[kind] ?? [];
  const priority = (id: string): number => {
    const index = order.indexOf(id);
    return index < 0 ? Number.POSITIVE_INFINITY : index;
  };
  // Разные команды могут объявлять один ID; разные ID одной марки не подменяем друг другом.
  return [...new Set(models.map((model) => model.id))].sort((a, b) => priority(a) - priority(b) || alphabetical(a, b));
}

function resolutionSize(value: string): number {
  const match = /^(\d+(?:\.\d+)?)\s*([kp])$/i.exec(value);
  if (match) return Number(match[1]) * (match[2].toLowerCase() === 'k' ? 1024 : 16 / 9);
  const dimensions = /^(\d+)\s*[x×]\s*(\d+)$/i.exec(value);
  return dimensions ? Math.sqrt(Number(dimensions[1]) * Number(dimensions[2])) : 0;
}

export function sortResolutions(values: readonly string[]): string[] {
  return [...new Set(values)].sort((a, b) => resolutionSize(b) - resolutionSize(a) || alphabetical(a, b));
}

export function sortAspects(values: readonly string[]): string[] {
  const ratio = (value: string): number => {
    const match = /^(\d+(?:\.\d+)?):(\d+(?:\.\d+)?)$/.exec(value);
    return match && Number(match[2]) > 0 ? Number(match[1]) / Number(match[2]) : 0;
  };
  // Пропорции не определяют качество: широкий кадр идёт первым, автоматический выбор — последним.
  return [...new Set(values)].sort((a, b) => Number(a === 'auto') - Number(b === 'auto') || ratio(b) - ratio(a) || alphabetical(a, b));
}

function declaredOptions(models: readonly MediaModel[], fields: string[]): string[] {
  // Разные команды одной модели могут объявлять разные варианты параметра.
  return models.flatMap((model) => fields.flatMap((field) => model.arguments[field]?.allowed ?? []));
}

export function resolutionOptions(models: readonly MediaModel[], selectedModel?: string): string[] {
  const selected = selectedModel ? models.filter((model) => model.id === selectedModel) : models;
  return sortResolutions(declaredOptions(selected, ['img_resolution', 'resolution']));
}

export function aspectOptions(models: readonly MediaModel[], selectedModel?: string): string[] {
  // Автоматический подбор использует весь каталог; явный ID ограничивает доступные пропорции.
  const selected = selectedModel ? models.filter((model) => model.id === selectedModel) : models;
  return sortAspects(declaredOptions(selected, ['aspect_ratio']));
}
