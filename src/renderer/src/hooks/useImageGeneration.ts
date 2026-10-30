import { sourcesTexts } from '@shared/texts/sources';
/** Общий цикл изображений: подготовка и согласование всегда предшествуют единственной отправке. */
import { useCallback, useEffect, useRef, useState } from 'react';
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

export function useImageGeneration(project: string, mode: 'cover' | 'reference' = 'cover') {
  const api = mode === 'reference' ? window.api.referenceImages : window.api.cover;
  const { describeError, notify, aiAccess } = useApp();
  // Обложку готовит провайдер изображений проекта; выбранный агент на неё не влияет.
  const blockedReason = aiActionProblem(aiAccess, 'image');
  const [session, setSession] = useState<CoverGenerationSession | null>(null);
  const [working, setWorking] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preparedSha, setPreparedSha] = useState<string | null>(null);
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

  const start = (prompt: string): Promise<CoverGenerationSession | null | undefined> =>
    perform(async () => {
      if (id.current || !prompt.trim()) return null;
      if (currentBlock.current) throw new Error(currentBlock.current);
      const created = await api.create(project, prompt.trim());
      id.current = created.id;
      // Закрытие диалога может опередить create: полученный позднее каталог всё равно удаляется.
      if (!update(created)) {
        await release(created.id);
        return null;
      }
      return prepare(created.id);
    });

  // Подготовка никогда не отправляет запрос: каждый провайдер ждёт отдельного подтверждения промпта.
  const next = (): Promise<CoverGenerationSession | null | undefined> => perform(async () => (session ? prepare(session.id) : null));

  const refreshQuote = next;

  const generate = (approval: CoverGenerationApproval): Promise<void | undefined> =>
    perform(async () => {
      if (referenceResult.current) return;
      if (!session?.requestSha || preparedSha !== session.requestSha || approval.approvalToken !== session.approvalToken) return;
      if (currentBlock.current) throw new Error(currentBlock.current);
      if (MEDIA_PROVIDERS[session.provider].paid && !priceAllowsGeneration(session.quote, approval.allowUnknownCost)) return;
      setPreparedSha(null);
      // Старый результат больше нельзя принять после запуска новой попытки, даже при ошибке IPC.
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
      if (!session?.image || session.status !== 'ready' || session.preparing) return;
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

  return { session, working, accepting, attachmentPending, error, preparedSha, start, next, refreshQuote, generate, accept };
}
