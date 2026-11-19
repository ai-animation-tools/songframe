import { sourcesTexts } from '@shared/texts/sources';
/** Общий цикл изображений: подготовка и согласование всегда предшествуют единственной отправке. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ReferenceImageGenerationInput } from '@shared/reference-image-generation';
import type { CoverCrop, CoverGenerationApproval, CoverGenerationSession } from '@shared/cover-generation';
import { MEDIA_PROVIDERS } from '@shared/media-providers';
import { priceAllowsGeneration } from '@shared/generation-consent';
import { aiActionProblem } from '@shared/ai-access';
import { useApp } from '../state';

export interface ImageGenerationResult {
  id: string;
  path: string;
  prompt?: string;
}

export function useImageGeneration(project: string, mode: 'cover' | 'reference' = 'cover', referenceInput?: ReferenceImageGenerationInput) {
  const api = mode === 'reference' ? window.api.referenceImages : window.api.cover;
  const { describeError, notify, aiAccess } = useApp();
  // Обложку готовит провайдер изображений проекта; выбранный агент на неё не влияет.
  const blockedReason = aiActionProblem(aiAccess, 'image');
  const [session, setSession] = useState<CoverGenerationSession | null>(null);
  const [working, setWorking] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preparedSha, setPreparedSha] = useState<string | null>(null);
  // Текст, отправленный в create текущей сессии: с ним сравнивается редактор, чтобы «Ещё» знало, нужна ли новая сессия.
  const [sessionPrompt, setSessionPrompt] = useState<string | null>(null);
  const alive = useRef(true);
  const locked = useRef(false);
  const id = useRef<string | null>(null);
  const accepted = useRef(false);
  const referenceResult = useRef<ImageGenerationResult | null>(null);
  const [attachmentPending, setAttachmentPending] = useState(false);
  const closed = useRef(new Map<string, Promise<void>>());
  const currentBlock = useRef(blockedReason);
  useEffect(() => {
    currentBlock.current = blockedReason;
  }, [blockedReason]);

  const release = useCallback(
    (sessionId: string): Promise<void> => {
      const previous = closed.current.get(sessionId);
      if (previous) return previous;
      const closing = api.close(sessionId);
      closed.current.set(sessionId, closing);
      return closing;
    },
    [api]
  );

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
      if (id.current && !accepted.current) {
        void release(id.current).catch((failure) => notify(describeError(failure), 'error'));
      }
    };
  }, [release, notify, describeError]);

  const update = useCallback((next: CoverGenerationSession): boolean => {
    if (!alive.current) return false;
    setSession(next);
    return true;
  }, []);

  const perform = useCallback(
    async <T>(action: () => Promise<T>): Promise<T | undefined> => {
      // Ref закрывает повторный клик до следующего React-render, включая платную отправку.
      if (locked.current || !alive.current) return;
      locked.current = true;
      setWorking(true);
      setError(null);
      try {
        return await action();
      } catch (failure) {
        if (alive.current) setError(describeError(failure));
      } finally {
        locked.current = false;
        if (alive.current) setWorking(false);
      }
    },
    [describeError]
  );

  const prepare = useCallback(
    async (sessionId: string): Promise<CoverGenerationSession | null> => {
      if (currentBlock.current) throw new Error(currentBlock.current);
      setPreparedSha(null);
      const next = await api.prepare(sessionId);
      if (!update(next)) return null;
      setPreparedSha(next.requestSha);
      return next;
    },
    [api, update]
  );

  /** Текст, который уходит в create: референс сохраняет точный текст редактора, обложка — без краевых пробелов. */
  const requestPrompt = useCallback((prompt: string): string => (mode === 'reference' ? prompt : prompt.trim()), [mode]);

  /** Создаёт сессию с текущими опорами и сразу готовит её; вызывается только внутри perform. */
  const create = async (prompt: string): Promise<CoverGenerationSession | null> => {
    if (currentBlock.current) throw new Error(currentBlock.current);
    const text = requestPrompt(prompt);
    // Оба вида запроса получают только явно выбранные опоры.
    const created = await (mode === 'reference'
      ? window.api.referenceImages.create(project, text, referenceInput ?? { images: [] })
      : window.api.cover.create(project, text, referenceInput ?? { images: [] }));
    id.current = created.id;
    // Закрытие диалога может опередить create: полученный позднее каталог всё равно удаляется.
    if (!update(created)) {
      await release(created.id);
      return null;
    }
    setSessionPrompt(text);
    return prepare(created.id);
  };

  const start = (prompt: string): Promise<CoverGenerationSession | null | undefined> =>
    perform(async () => {
      if (id.current || !prompt.trim()) return null;
      return create(prompt);
    });

  /** Правку запроса нельзя начать во время отправки, принятия и незавершённой привязки оплаченного оригинала. */
  const editable = (): boolean => !(locked.current || session?.status === 'generating' || accepting || referenceResult.current);

  /** Закрывает текущую сессию без принятия; кандидат и согласования пропадают до следующего render. */
  const dropSession = (): void => {
    const previous = id.current;
    id.current = null;
    accepted.current = false;
    setSession(null);
    setSessionPrompt(null);
    setPreparedSha(null);
    setError(null);
    setAttachmentPending(false);
    if (previous) void release(previous).catch((failure) => notify(describeError(failure), 'error'));
  };

  /** Новый текст или набор опор снимает согласование и кандидат до следующего render. */
  const invalidate = (): boolean => {
    if (!editable()) return false;
    dropSession();
    return true;
  };

  /**
   * Правка текста после попытки: кандидат и ошибка прежней попытки остаются на виду, а подготовленный
   * запрос, его цена и согласования сразу перестают действовать. Новую сессию создаёт только «Ещё».
   */
  const editPrompt = (): boolean => {
    if (!editable()) return false;
    setPreparedSha(null);
    return true;
  };

  /** Текст редактора расходится с тем, по которому создана текущая сессия. */
  const promptChanged = (prompt: string): boolean => sessionPrompt !== null && requestPrompt(prompt) !== sessionPrompt;

  /**
   * Следующая попытка. Без правки текста готовится та же сессия с прежними опорами. Изменённый текст
   * закрывает прежнюю сессию и создаёт новую с теми же выбранными опорами: у неё новые SHA, оценка цены
   * и токен согласования, поэтому прежнее согласие на неё не распространяется. Подготовка никогда
   * не отправляет запрос: каждый провайдер ждёт отдельного подтверждения промпта.
   */
  const next = (prompt?: string): Promise<CoverGenerationSession | null | undefined> =>
    perform(async () => {
      if (!session || id.current !== session.id) return null;
      if (prompt === undefined || !promptChanged(prompt)) return prepare(session.id);
      if (!prompt.trim() || accepting || referenceResult.current) return null;
      dropSession();
      return create(prompt);
    });

  /** Новая оценка цены той же подготовленной сессии; текст и опоры при этом не меняются. */
  const refreshQuote = (): Promise<CoverGenerationSession | null | undefined> =>
    perform(async () => (session && id.current === session.id ? prepare(session.id) : null));

  const generate = (approval: CoverGenerationApproval): Promise<void | undefined> =>
    perform(async () => {
      if (referenceResult.current) return;
      if (!session?.requestSha || id.current !== session.id || preparedSha !== session.requestSha || approval.approvalToken !== session.approvalToken) return;
      if (currentBlock.current) throw new Error(currentBlock.current);
      if (MEDIA_PROVIDERS[session.provider].paid && !priceAllowsGeneration(session.quote, approval.allowUnknownCost)) return;
      setPreparedSha(null);
      // Старый результат больше нельзя принять после запуска новой попытки, даже при ошибке вызова API.
      setSession({ ...session, status: 'generating', image: null, error: null });
      try {
        update(await api.generate(session.id, session.requestSha, approval));
      } catch (failure) {
        if (alive.current) setSession({ ...session, status: 'failed', image: null, error: describeError(failure), requestSha: null, approvalToken: null });
        throw failure;
      }
    });

  const accept = (crop: CoverCrop | null, onAccepted: (result: ImageGenerationResult) => void | Promise<void>): Promise<void | undefined> =>
    perform(async () => {
      if (!session?.image || id.current !== session.id || session.status !== 'ready' || session.preparing) return;
      setAccepting(true);
      try {
        const result =
          mode === 'reference'
            ? (referenceResult.current ?? (await window.api.referenceImages.accept(session.id)))
            : crop
              ? await window.api.cover.accept(session.id, crop)
              : null;
        if (!result) return;
        if (mode === 'reference') {
          referenceResult.current = result;
          if (alive.current) setAttachmentPending(true);
        }
        if (!alive.current) return;
        // Ошибка привязки не закрывает окно: повтор приёмки использует тот же оплаченный оригинал.
        await onAccepted(result);
        accepted.current = true;
      } finally {
        if (alive.current) setAccepting(false);
      }
    });

  const sessionId = session?.id;
  const generating = session?.status === 'generating';
  useEffect(() => {
    if (!sessionId || !generating) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async (): Promise<void> => {
      try {
        const next = await api.view(sessionId);
        if (cancelled || !alive.current) return;
        update(next);
        setError(null);
        if (next.status !== 'generating') return;
      } catch (failure) {
        if (cancelled || !alive.current) return;
        setError(sourcesTexts.coverRefreshError({ reason: describeError(failure) }));
      }
      timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [api, sessionId, generating, update, describeError]);

  return {
    session,
    working,
    accepting,
    attachmentPending,
    error,
    preparedSha,
    start,
    next,
    refreshQuote,
    generate,
    accept,
    invalidate,
    editPrompt,
    promptChanged
  };
}
