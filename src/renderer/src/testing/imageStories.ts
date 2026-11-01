/** Локальные сессии витрины проходят настоящий hook; подготовка никогда не создаёт кандидата. */
import type { AiAccess } from '@shared/ai-access';
import type { CoverGenerationApproval, CoverGenerationApi, CoverGenerationSession, GenerationReferenceImage } from '@shared/cover-generation';
import type { ReferenceImageGenerationApi, ReferenceImageGenerationInput } from '@shared/reference-image-generation';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { referenceGenerationMessages } from '@shared/texts/reference-images';
import { TEST_AGENT_PROVIDER, TEST_PROVIDER, testAgentProviderInfo, testProviderInfo } from '@shared/testing/media-provider';
import { createStoryApi, type ApiOverrides, type StoryApiSession, type StoryOptions } from './storybook';

export const IMAGE_STORY_PROJECT = '/mock/Клип с длинным названием';
export const IMAGE_STORY_PATH = '/mock/story-image.png';
export const IMAGE_STORY_TARGET = 'Олег у старых дачных ворот — основной образ персонажа';
export const IMAGE_STORY_PROMPT =
  'Олег у деревянных ворот на закате. Сохранить лицо, одежду и пропорции персонажа. Мягкий объёмный свет, подробная трёхмерная иллюстрация.';
export const IMAGE_STORY_STYLE = 'Подробная трёхмерная иллюстрация, округлые формы и мягкий вечерний свет.';
export const IMAGE_STORY_IDEA = 'Герой возвращается к старым воротам после долгой дороги.';
export const IMAGE_STORY_LYRICS = '[Куплет 1]\nУ ворот встречает вечер';
export const IMAGE_STORY_INPUT: ReferenceImageGenerationInput = {
  images: [{ path: IMAGE_STORY_PATH, label: 'Спереди' }]
};
export const IMAGE_ATTACHMENT_ERROR = 'Не удалось привязать изображение к персонажу. Повторите принятие: готовый оригинал сохранён.';

export function imageStoryAccess(provider: string | null = TEST_PROVIDER): AiAccess {
  return {
    agent: { provider: 'codex', selected: true, available: true, message: '' },
    image: { provider, selected: !!provider, available: !!provider, message: provider ? '' : 'Выберите провайдера изображений в настройках проекта.' },
    video: { provider: null, selected: false, available: false, message: 'Выберите провайдера видео.' }
  };
}

export interface ImageModelOptions {
  provider?: typeof TEST_PROVIDER | typeof TEST_AGENT_PROVIDER;
  quote?: 'known' | 'unknown' | 'insufficient';
  failContextOnce?: boolean;
  failInspectOnce?: boolean;
  missingReferenceImageInspection?: boolean;
  longContext?: boolean;
  preparePending?: boolean;
  delayCreate?: boolean;
  failPreparationOnce?: boolean;
  generating?: boolean;
  failGenerationOnce?: boolean;
  failAttachmentOnce?: boolean;
}

export interface ImageModelInspection {
  contexts: { project: string; drafts?: { idea?: string; lyrics?: string } }[];
  closes: string[];
  creates: { mode: 'cover' | 'reference'; project: string; prompt: string; input?: ReferenceImageGenerationInput }[];
  generations: number;
  attachments: string[];
  sessions: CoverGenerationSession[];
}
let activeCreateRelease: (() => void) | null = null;
/** Управляемая задержка нужна для проверки гонки между просмотром исходных опор и ответом create. */
export function completeImageStoryCreate(): void {
  activeCreateRelease?.();
}
let activeInspection: (() => ImageModelInspection) | null = null;
export function imageStoryInspection(): ImageModelInspection {
  if (!activeInspection) throw new Error('Модель изображений не открыта.');
  return activeInspection();
}

/** Сохраняем один оплаченный оригинал: после сбоя attach повтор accept не создаёт ни сессию, ни запрос. */
export function createImageModel(options: ImageModelOptions = {}): {
  api: ApiOverrides;
  inspect(): ImageModelInspection;
  completeCreate(): void;
  dispose(): void;
} {
  const inspection: ImageModelInspection = { contexts: [], closes: [], creates: [], generations: 0, attachments: [], sessions: [] };
  const sessions = new Map<string, CoverGenerationSession>();
  const accepted = new Set<string>();
  const polls = new Map<string, number>();
  const pending = new Set<() => void>();
  let releaseCreate: (() => void) | null = null;
  const completeCreate = (): void => releaseCreate?.();
  let disposed = false;
  let sequence = 0;
  let preparation = 0;
  let contextReads = 0;
  let imageInspections = 0;
  let generation = 0;
  let attachment = 0;
  const snapshot = (session: CoverGenerationSession): CoverGenerationSession => structuredClone(session);
  const sessionOf = (id: string): CoverGenerationSession => {
    const session = sessions.get(id);
    if (!session || disposed) throw new Error('Сессия изображения уже закрыта.');
    return session;
  };
  const ready = (id: string): CoverGenerationSession => {
    const session = sessionOf(id);
    if (session.status !== 'ready' || !session.image) throw new Error('Сначала дождитесь готового изображения.');
    return session;
  };
  const quote = (): CoverGenerationSession['quote'] => {
    if (options.provider === TEST_AGENT_PROVIDER) return null;
    if (options.quote === 'unknown') return { credits: null, balance: 120, verdict: 'cost_or_balance_unknown' };
    if (options.quote === 'insufficient' && preparation === 1) return { credits: 18, balance: 3, verdict: 'insufficient_balance' };
    return { credits: 18, balance: 120, verdict: 'ok' };
  };
  const create: CoverGenerationApi['create'] = async (project, prompt) => {
    inspection.creates.push({ mode: 'cover', project, prompt });
    if (disposed) throw new Error('История уже закрыта.');
    const id = `story-image-${++sequence}`;
    const session: CoverGenerationSession = {
      id,
      prompt,
      status: 'idle',
      image: null,
      error: null,
      provider: options.provider ?? TEST_PROVIDER,
      model: 'test-image',
      preparing: false,
      requestSha: null,
      approvalToken: null,
      quote: null
    };
    sessions.set(id, session);
    return snapshot(session);
  };
  const prepare: CoverGenerationApi['prepare'] = async (id) => {
    const session = sessionOf(id);
    preparation++;
    if (options.preparePending) {
      // Незавершённую подготовку можно закрыть; cleanup завершит Promise после ухода истории.
      await new Promise<void>((resolve) => pending.add(resolve));
      return snapshot(session);
    }
    if (options.failPreparationOnce && preparation === 1) throw new Error('Не удалось подготовить запрос. Повторите подготовку.');
    session.requestSha = (preparation % 10).toString().repeat(64);
    session.approvalToken = `${id}-approval-${preparation}`;
    session.quote = quote();
    session.error = null;
    return snapshot(session);
  };
  const generate: CoverGenerationApi['generate'] = async (id, sha, approval: CoverGenerationApproval) => {
    const session = sessionOf(id);
    if (sha !== session.requestSha || approval.approvalToken !== session.approvalToken || !approval.promptConfirmed) {
      throw new Error('Подтвердите промпт текущей подготовки.');
    }
    if (session.quote?.verdict === 'insufficient_balance' || (session.quote?.verdict === 'cost_or_balance_unknown' && !approval.allowUnknownCost)) {
      throw new Error('Согласуйте цену текущего запроса.');
    }
    generation++;
    inspection.generations++;
    session.status = 'generating';
    session.image = null;
    session.error = null;
    session.requestSha = null;
    session.approvalToken = null;
    session.quote = null;
    polls.set(id, 0);
    return snapshot(session);
  };
  const view: CoverGenerationApi['view'] = async (id) => {
    const session = sessionOf(id);
    if (session.status === 'generating' && !options.generating) {
      const count = (polls.get(id) ?? 0) + 1;
      polls.set(id, count);
      session.status = options.failGenerationOnce && generation === 1 ? 'failed' : 'ready';
      session.error = session.status === 'failed' ? 'Генерация завершилась с ошибкой. Можно подготовить новую попытку.' : null;
      session.image = session.status === 'ready' ? { path: IMAGE_STORY_PATH, width: 64, height: 36 } : null;
    }
    return snapshot(session);
  };
  const close: CoverGenerationApi['close'] = async (id) => {
    inspection.closes.push(id);
    sessions.delete(id);
    polls.delete(id);
  };
  const cover: CoverGenerationApi = {
    create,
    prepare,
    generate,
    view,
    close,
    accept: async (id, crop) => {
      const session = ready(id);
      const image = session.image!;
      if (crop.x < 0 || crop.y < 0 || crop.size <= 0 || crop.x + crop.size > image.width || crop.y + crop.size > image.height) {
        throw new Error('Квадрат должен оставаться внутри изображения.');
      }
      accepted.add(id);
      return { id, path: IMAGE_STORY_PATH };
    }
  };
  // Путь задаёт байты фикстуры: одинаковые пути совпадают, разные опоры получают разные SHA.
  const inspectInputs = async (input: ReferenceImageGenerationInput): Promise<GenerationReferenceImage[]> =>
    Promise.all(
      input.images.map(async (image) => {
        const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(image.path));
        const sha256 = [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
        if (image.sha256 !== undefined && image.sha256 !== sha256) throw new Error(referenceGenerationMessages.referenceInputsChanged);
        return { path: image.path, label: image.label.trim(), sha256, bytes: 1024 };
      })
    );
  const referenceImages: ReferenceImageGenerationApi = {
    inspect: async (input) => {
      if (options.failInspectOnce && ++imageInspections === 1) throw new Error(referenceGenerationMessages.referenceInputsInvalid);
      return inspectInputs(input);
    },
    context: async (project, drafts) => {
      inspection.contexts.push({ project, drafts: drafts ? structuredClone(drafts) : undefined });
      if (options.failContextOnce && ++contextReads === 1) throw new Error('Не удалось прочитать контекст клипа.');
      return {
        clipName: 'У старых ворот',
        idea: drafts?.idea ?? IMAGE_STORY_IDEA,
        lyrics: drafts?.lyrics ?? IMAGE_STORY_LYRICS,
        visualStyle: options.longContext ? Array.from({ length: 80 }, (_, i) => `${i + 1}. ${IMAGE_STORY_STYLE}`).join('\n') : IMAGE_STORY_STYLE
      };
    },
    create: async (project, prompt, input) => {
      const inspected = await inspectInputs(input ?? { images: [] });
      const session = await create(project, prompt);
      inspection.creates.pop();
      inspection.creates.push({ mode: 'reference', project, prompt, input: input ? structuredClone(input) : undefined });
      const stored = sessionOf(session.id);
      // Сессия сохраняет ровно отредактированный текст, без скрытой композиции контекста.
      stored.prompt = prompt;
      // Как и backend, объединяем совпавшие байты без скрытых описаний в транспортных метаданных.
      const unique = new Map<string, GenerationReferenceImage>();
      for (const image of inspected) {
        const previous = unique.get(image.sha256);
        if (previous) {
          if (!previous.label.split(' · ').includes(image.label)) previous.label += ` · ${image.label}`;
        } else unique.set(image.sha256, { ...image });
      }
      stored.referenceImages = [...unique.values()].map((image, index) => ({
        ...image,
        path: `/mock/private-session/${session.id}/${index}/story-image.png`
      }));
      if (options.delayCreate)
        await new Promise<void>((resolve) => {
          releaseCreate = () => {
            pending.delete(resolve);
            releaseCreate = null;
            resolve();
          };
          pending.add(resolve);
        });
      return snapshot(stored);
    },
    prepare,
    generate,
    view,
    close,
    accept: async (id) => {
      const session = ready(id);
      accepted.add(id);
      return { id, path: IMAGE_STORY_PATH, prompt: session.prompt };
    },
    attach: async (id, entityId) => {
      ready(id);
      if (!accepted.has(id)) throw new Error('Сначала примите полный оригинал.');
      if (options.failAttachmentOnce && ++attachment === 1) throw new Error(IMAGE_ATTACHMENT_ERROR);
      inspection.attachments.push(entityId);
    }
  };
  return {
    api: { cover, referenceImages },
    completeCreate,
    inspect: () => structuredClone({ ...inspection, sessions: [...sessions.values()] }),
    dispose() {
      disposed = true;
      for (const resolve of pending) resolve();
      pending.clear();
      sessions.clear();
      accepted.clear();
      polls.clear();
    }
  };
}

export function imageStoryOptions(options: ImageModelOptions = {}, selected = true): StoryOptions {
  return {
    app: { aiAccess: imageStoryAccess(selected ? (options.provider ?? TEST_PROVIDER) : null), agentProvider: 'codex' },
    createApi: (): StoryApiSession => {
      const model = createImageModel(options);
      activeInspection = model.inspect;
      activeCreateRelease = model.completeCreate;
      const session = createStoryApi(model.api, { missingReferenceImageInspection: options.missingReferenceImageInspection });
      session.onCleanup(registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo));
      session.onCleanup(registerMediaProviderForTests(TEST_AGENT_PROVIDER, testAgentProviderInfo));
      session.onCleanup(model.dispose);
      session.onCleanup(() => {
        if (activeInspection === model.inspect) activeInspection = null;
        if (activeCreateRelease === model.completeCreate) activeCreateRelease = null;
      });
      return session;
    }
  };
}

export const INSTRUCTION_STORY_TEXT =
  'Сохраняй узнаваемость персонажей и последовательность событий.\r\nНе меняй утверждённые исходники без отдельного согласования.\n\nУчитывай музыкальный ритм и настроение сцены.';
export const INSTRUCTION_STORY_LONG_TEXT = Array.from(
  { length: 12 },
  (_, index) =>
    `${index + 1}. Сохраняй внешность Олега, направление движения и характер освещения между соседними планами. Подробное описание сцены остаётся читаемым при узкой рабочей области.\r\n\nНе добавляй новые события без согласования.`
).join('\n\n');
