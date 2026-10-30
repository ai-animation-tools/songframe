/** Локальные сессии витрины проходят настоящий hook; подготовка никогда не создаёт кандидата. */
import type { AiAccess } from '@shared/ai-access';
import type { CoverGenerationApproval, CoverGenerationApi, CoverGenerationSession } from '@shared/cover-generation';
import type { ReferenceImageGenerationApi } from '@shared/reference-image-generation';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { TEST_AGENT_PROVIDER, TEST_PROVIDER, testAgentProviderInfo, testProviderInfo } from '@shared/testing/media-provider';
import { createStoryApi, type ApiOverrides, type StoryApiSession, type StoryOptions } from './storybook';

export const IMAGE_STORY_PROJECT = '/mock/Клип с длинным названием';
export const IMAGE_STORY_PATH = '/mock/story-image.png';
export const IMAGE_STORY_TARGET = 'Олег у старых дачных ворот — основной образ персонажа';
export const IMAGE_STORY_PROMPT =
  'Олег у деревянных ворот на закате. Сохранить лицо, одежду и пропорции персонажа. Мягкий объёмный свет, подробная трёхмерная иллюстрация.';
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
  preparePending?: boolean;
  failPreparationOnce?: boolean;
  generating?: boolean;
  failGenerationOnce?: boolean;
  failAttachmentOnce?: boolean;
}

/** Сохраняем один оплаченный оригинал: после сбоя attach повтор accept не создаёт ни сессию, ни запрос. */
export function createImageModel(options: ImageModelOptions = {}): { api: ApiOverrides; dispose(): void } {
  const sessions = new Map<string, CoverGenerationSession>();
  const accepted = new Set<string>();
  const polls = new Map<string, number>();
  const pending = new Set<() => void>();
  let disposed = false;
  let sequence = 0;
  let preparation = 0;
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
  const create: CoverGenerationApi['create'] = async (_project, prompt) => {
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
    session.requestSha = 'a'.repeat(64);
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
  const referenceImages: ReferenceImageGenerationApi = {
    create,
    prepare,
    generate,
    view,
    close,
    accept: async (id) => {
      const session = ready(id);
      accepted.add(id);
      return { id, path: IMAGE_STORY_PATH, prompt: session.prompt };
    },
    attach: async (id, _entityId) => {
      ready(id);
      if (!accepted.has(id)) throw new Error('Сначала примите полный оригинал.');
      if (options.failAttachmentOnce && ++attachment === 1) throw new Error(IMAGE_ATTACHMENT_ERROR);
    }
  };
  return {
    api: { cover, referenceImages },
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
      const session = createStoryApi(model.api);
      session.onCleanup(registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo));
      session.onCleanup(registerMediaProviderForTests(TEST_AGENT_PROVIDER, testAgentProviderInfo));
      session.onCleanup(model.dispose);
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
