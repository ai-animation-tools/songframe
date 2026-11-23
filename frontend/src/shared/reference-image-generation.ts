import type { CoverGenerationApi, CoverGenerationSession, GenerationReferenceImage } from './cover-generation';

/** Принятый полный оригинал остаётся в сессии до сохранения исходников или привязки к сущности. */
export interface ReferenceImageResult {
  id: string;
  path: string;
  prompt: string;
}

/** Контекст доступен конструктору отдельно и не добавляется к отправляемому промпту автоматически. */
export interface ReferenceImageContext {
  clipName: string;
  idea: string;
  lyrics: string;
  visualStyle: string;
}
/** Несохранённый текст исходников имеет приоритет при чтении контекста конструктора. */
export interface ReferenceImageContextDrafts {
  idea?: string;
  lyrics?: string;
}
/** Примечание доступно только конструктору; в метаданные запроса передаются нейтральные подписи. */
export interface ReferenceImageOption {
  path: string;
  label: string;
  note?: string;
}

/** Только явно выбранные опоры; видимый отредактированный промпт передаётся отдельной строкой. */
export interface ReferenceImageGenerationInput {
  images: { path: string; label: string; sha256?: string }[];
}

export type ReferenceImageGenerationApi = Omit<CoverGenerationApi, 'accept' | 'create'> & {
  /** Локальное чтение опор позволяет показать номера после объединения одинаковых изображений. */
  inspect(input: ReferenceImageGenerationInput): Promise<GenerationReferenceImage[]>;
  context(project: string, drafts?: ReferenceImageContextDrafts): Promise<ReferenceImageContext>;
  create(project: string, prompt: string, input?: ReferenceImageGenerationInput): Promise<CoverGenerationSession>;
  accept(id: string): Promise<ReferenceImageResult>;
  /** Добавляет изображение в исходники и сохранённую сущность без замены прежних изображений. */
  attach(id: string, entityId: string): Promise<void>;
};

/**
 * Виды референсов, у которых светлый однородный фон по умолчанию выключен: место и стиль — это
 * само окружение, а мир кастинга не изображается отдельным объектом. Остальные виды, включая
 * пользовательские, — объект, который удобнее отделять от фона.
 */
const SCENE_KINDS = new Set(['location', 'style', 'world']);

/** Включён ли светлый однородный фон по умолчанию для референса вида kind (неизвестный вид — объект). */
export function plainBackgroundByDefault(kind: string | undefined): boolean {
  return !SCENE_KINDS.has(kind ?? '');
}

/** Указание исполнителю о фоне; добавляется к промпту, пока галочка включена. */
// eslint-disable-next-line no-restricted-syntax -- Инструкция генерации не относится к словарю UI.
export const PLAIN_BACKGROUND_PROMPT = 'Фон — светлый однородный, без окружения и посторонних предметов: объект должен легко отделяться от фона.';

/** Начальный промпт задаёт объект; пользователь уточняет его перед подготовкой запроса. */
export function referenceImagePrompt(input: { name: string; description?: string; appearance?: string }): string {
  const details = [input.description?.trim(), input.appearance?.trim()].filter(Boolean).join('\n\n');
  // eslint-disable-next-line no-restricted-syntax -- Исходная инструкция генерации не относится к словарю UI.
  return `Создай изображение референса для музыкального клипа. Объект: ${input.name.trim() || 'без названия'}.${details ? `\n\n${details}` : ''}`;
}
