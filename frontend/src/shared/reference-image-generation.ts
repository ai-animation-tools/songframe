import type { CoverGenerationApi, CoverGenerationSession, GenerationReferenceImage } from './cover-generation';
import type { ReferenceView } from './types';

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
  /**
   * Добавляет изображение в исходники и сохранённую сущность без замены прежних изображений; view —
   * ракурс из окна генерации, без него — «В полный рост» у первого изображения, иначе «Другое».
   */
  attach(id: string, entityId: string, view?: ReferenceView | null): Promise<void>;
};

/**
 * Виды референсов, у которых указания для объекта (светлый фон, целиком в кадре, ровный свет) по
 * умолчанию выключены: место и стиль — это само окружение со своим светом, а мир кастинга не
 * изображается отдельным объектом. Остальные виды, включая пользовательские, — объект.
 */
const SCENE_KINDS = new Set(['location', 'style', 'world']);

/** Включён ли светлый однородный фон по умолчанию для референса вида kind (неизвестный вид — объект). */
export function plainBackgroundByDefault(kind: string | undefined): boolean {
  return !SCENE_KINDS.has(kind ?? '');
}

/** Указания исполнителю, которые конструктор добавляет к промпту, пока включён параметр. */
/* eslint-disable no-restricted-syntax -- Инструкции генерации не относятся к словарю UI. */
export const PLAIN_BACKGROUND_PROMPT = 'Фон — светлый однородный, без окружения и посторонних предметов: объект должен легко отделяться от фона.';
export const WHOLE_OBJECT_PROMPT = 'Объект виден целиком, ничего не обрезано краем кадра.';
export const EVEN_LIGHT_PROMPT = 'Свет ровный и рассеянный, без цветных и резких теней: цвета и материалы видны такими, какие они есть.';
/** Ракурс в промпте; «Другое» не выбирается — это вид без указания. */
export const REFERENCE_VIEW_PROMPTS: Record<Exclude<ReferenceView, 'other'>, string> = {
  full: 'Ракурс: в полный рост.',
  face: 'Ракурс: крупный план лица, спереди.',
  front: 'Ракурс: спереди.',
  side: 'Ракурс: сбоку, в профиль.',
  back: 'Ракурс: сзади.',
  top: 'Ракурс: сверху.'
};
/* eslint-enable no-restricted-syntax */

/** Параметры конструктора референса: указания исполнителю и ракурс (null — не задан). */
export interface ReferencePromptOptions {
  plainBackground: boolean;
  wholeObject: boolean;
  evenLight: boolean;
  view: Exclude<ReferenceView, 'other'> | null;
}

/** Параметры по умолчанию для референса вида kind: у объекта указания включены, ракурс не задан. */
export function defaultReferenceOptions(kind: string | undefined): ReferencePromptOptions {
  const object = plainBackgroundByDefault(kind);
  return { plainBackground: object, wholeObject: object, evenLight: object, view: null };
}

/**
 * Строки указаний по параметрам в порядке промпта: ракурс, целиком, фон, свет. Крупный план лица
 * по смыслу не целиком, поэтому «целиком в кадре» при нём не добавляется.
 */
export function referenceOptionLines(options: ReferencePromptOptions): string[] {
  return [
    options.view ? REFERENCE_VIEW_PROMPTS[options.view] : '',
    options.wholeObject && options.view !== 'face' ? WHOLE_OBJECT_PROMPT : '',
    options.plainBackground ? PLAIN_BACKGROUND_PROMPT : '',
    options.evenLight ? EVEN_LIGHT_PROMPT : ''
  ].filter(Boolean);
}

/** Начальный промпт задаёт объект; пользователь уточняет его перед подготовкой запроса. */
export function referenceImagePrompt(input: { name: string; description?: string; appearance?: string }): string {
  const details = [input.description?.trim(), input.appearance?.trim()].filter(Boolean).join('\n\n');
  // eslint-disable-next-line no-restricted-syntax -- Исходная инструкция генерации не относится к словарю UI.
  return `Создай изображение референса для музыкального клипа. Объект: ${input.name.trim() || 'без названия'}.${details ? `\n\n${details}` : ''}`;
}
