/** Жизненный цикл временной обложки; платная отправка всегда отделена от подготовки цены. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { CoverCrop, CoverGenerationApproval, CoverGenerationSession } from '@shared/cover-generation';
import { COVER_AGENT_REQUIRED } from '@shared/cover-generation';
import { priceAllowsGeneration } from '@shared/generation-consent';
import { aiActionProblem } from '@shared/ai-access';
import { useApp } from '../../state';

export function useCoverGeneration(project: string) {
  const { describeError, notify, agentProvider, aiAccess } = useApp();
  const blockedReason = !agentProvider ? COVER_AGENT_REQUIRED : aiActionProblem(aiAccess, 'image');
  const [session, setSession] = useState<CoverGenerationSession | null>(null);
  const [working, setWorking] = useState(false);
  const [accepting, setAccepting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [preparedSha, setPreparedSha] = useState<string | null>(null);
  const alive = useRef(true);
  const locked = useRef(false);
  const id = useRef<string | null>(null);
  const accepted = useRef(false);
  const closed = useRef(new Map<string, Promise<void>>());
  const currentBlock = useRef(blockedReason);
  useEffect(() => {
    currentBlock.current = blockedReason;
  }, [blockedReason]);

  const release = useCallback((sessionId: string): Promise<void> => {
    const previous = closed.current.get(sessionId);
    if (previous) return previous;
    const closing = window.api.cover.close(sessionId);
    closed.current.set(sessionId, closing);
    return closing;
  }, []);

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
      const next = await window.api.cover.prepare(sessionId);
      if (!update(next)) return null;
      setPreparedSha(next.requestSha);
      return next;
    },
    [update]
  );

  const start = (prompt: string): Promise<CoverGenerationSession | null | undefined> =>
    perform(async () => {
      if (id.current || !prompt.trim()) return null;
      if (currentBlock.current) throw new Error(currentBlock.current);
      const created = await window.api.cover.create(project, prompt.trim());
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
      if (!session?.requestSha || preparedSha !== session.requestSha || approval.approvalToken !== session.approvalToken) return;
      if (currentBlock.current) throw new Error(currentBlock.current);
      if (session.provider === 'kling' && !priceAllowsGeneration(session.quote, approval.allowUnknownCost)) return;
      setPreparedSha(null);
      // Старый результат больше нельзя принять после запуска новой попытки, даже при ошибке IPC.
      setSession({ ...session, status: 'generating', image: null, error: null });
      try {
        update(await window.api.cover.generate(session.id, session.requestSha, approval));
      } catch (failure) {
        if (alive.current) setSession({ ...session, status: 'failed', image: null, error: describeError(failure), requestSha: null, approvalToken: null });
        throw failure;
      }
    });

  const accept = (crop: CoverCrop, onAccepted: (result: { id: string; path: string }) => void): Promise<void | undefined> =>
    perform(async () => {
      if (!session?.image || session.status !== 'ready' || session.preparing) return;
      setAccepting(true);
      try {
        const result = await window.api.cover.accept(session.id, crop);
        if (!alive.current) return;
        accepted.current = true;
        onAccepted(result);
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
        const next = await window.api.cover.view(sessionId);
        if (cancelled || !alive.current) return;
        update(next);
        setError(null);
        if (next.status !== 'generating') return;
      } catch (failure) {
        if (cancelled || !alive.current) return;
        setError(`Не удалось обновить состояние: ${describeError(failure)}. Проверка продолжится автоматически.`);
      }
      timer = setTimeout(() => void poll(), 1000);
    };
    timer = setTimeout(() => void poll(), 500);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [sessionId, generating, update, describeError]);

  return { session, working, accepting, error, preparedSha, start, next, refreshQuote, generate, accept };
}
