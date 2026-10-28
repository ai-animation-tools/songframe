/** Смена провайдера в настройках генерации: поля проекта остаются, всё зависящее от провайдера заменяется значениями нового. */
import { mediaProviderInfo, type MediaKind } from './media-providers';
import type { ImageGenerationSettings, VideoGenerationSettings } from './types';

/**
 * Поля, которые задаёт сам проект и которые не зависят от провайдера: требования к клипу и к оригиналам.
 * Перечислены именно они: любое другое поле (модель, параметры запроса, options, будущие поля провайдера) при смене провайдера сбрасывается.
 */
export const PROJECT_GENERATION_FIELDS: Readonly<Record<MediaKind, readonly string[]>> = {
  // Разрешение, пропорции и правило длительности — требования к видео клипа; провайдер их только проверяет.
  video: ['resolution', 'aspect_ratio', 'duration_rule', 'watermark'],
  image: ['watermark']
};

/** Настройки после явного выбора другого провайдера: поля проекта сохраняются, остальные берутся из значений по умолчанию нового провайдера. */
export function switchGenerationProvider<T extends VideoGenerationSettings | ImageGenerationSettings>(kind: MediaKind, value: T, provider: string): T {
  const kept = Object.fromEntries(Object.entries(value).filter(([key]) => PROJECT_GENERATION_FIELDS[kind].includes(key)));
  const info = mediaProviderInfo(provider, kind);
  // Значения по умолчанию не перекрывают поля проекта: провайдер получает требования проекта как есть.
  const defaults = info?.requestParameters ? (info.defaults[kind] ?? {}) : {};
  return { ...defaults, ...kept, provider, provider_selected: true } as T;
}
