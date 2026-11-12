/** Список журнала отправок проекта: первое чтение и опрос, пока страница открыта. */
import { useCallback, useEffect, useState } from 'react';
import type { PromptLogSummary } from '@shared/types';
import { useApp } from '../../state';

/** Интервал опроса: выполняющиеся отправки сменяют итог без ручного обновления. */
export const PROMPT_LOG_POLL_MS = 3000;

export function usePromptLog(project: string) {
  const { describeError } = useApp();
  const [entries, setEntries] = useState<PromptLogSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setEntries(await window.api.promptLog.list(project));
      setError(null);
    } catch (reason) {
      setError(describeError(reason));
    }
  }, [project, describeError]);

  useEffect(() => {
    setEntries(null);
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const read = async (): Promise<void> => {
      await load();
      if (active) timer = setTimeout(() => void read(), PROMPT_LOG_POLL_MS);
    };
    void read();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [load]);

  return { entries, error };
}
