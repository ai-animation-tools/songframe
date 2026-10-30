import type { CoverGenerationApi } from './cover-generation';

/** Принятый полный оригинал остаётся в сессии до сохранения исходников или привязки к сущности. */
export interface ReferenceImageResult {
  id: string;
  path: string;
  prompt: string;
}

export type ReferenceImageGenerationApi = Omit<CoverGenerationApi, 'accept'> & {
  accept(id: string): Promise<ReferenceImageResult>;
  /** Добавляет изображение в исходники и сохранённую сущность без замены прежних изображений. */
  attach(id: string, entityId: string): Promise<void>;
};

/** Начальный промпт задаёт объект; пользователь уточняет его перед подготовкой запроса. */
export function referenceImagePrompt(input: { name: string; description?: string; appearance?: string }): string {
  const details = [input.description?.trim(), input.appearance?.trim()].filter(Boolean).join('\n\n');
  // eslint-disable-next-line no-restricted-syntax -- Исходная инструкция генерации не относится к словарю UI.
  return `Создай изображение референса для музыкального клипа. Объект: ${input.name.trim() || 'без названия'}.${details ? `\n\n${details}` : ''}`;
}
