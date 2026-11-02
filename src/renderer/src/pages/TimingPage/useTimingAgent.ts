import { useCallback, useEffect, useRef, useState } from 'react';
import type { TimingAgentView } from '@shared/timing-agent';
import { timingAgentTexts } from '@shared/texts/timing-agent';

/** Опрос не отменяет задание при размонтировании: остановка принадлежит явной кнопке диалога. */
export function useTimingAgent(project: string, describeError: (error: unknown) => string) {
  const [view, setView] = useState<TimingAgentView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [working, setWorking] = useState(false);
  const alive = useRef(false);
  const revision = useRef(0);
  const locked = useRef(false);
  const available = typeof window.api.timingAgent?.view === 'function';

  useEffect(() => {
    alive.current = true;
    const token = ++revision.current;
    if (!available) setError(timingAgentTexts.restartRequired);
    else
      void window.api.timingAgent
        .view(project)
        .then((next) => {
          if (alive.current && token === revision.current) setView(next);
        })
        .catch((reason) => {
          if (alive.current && token === revision.current) setError(describeError(reason));
        });
    return () => {
      alive.current = false;
    };
  }, [project, available, describeError]);

  useEffect(() => {
    if (view?.status !== 'running' || !available) return;
    let live = true;
    let polling = false;
    const timer = window.setInterval(() => {
      if (locked.current || polling) return;
      polling = true;
      const token = revision.current;
      void window.api.timingAgent
        .view(project)
        .then((next) => {
          if (live && alive.current && token === revision.current) {
            setView(next);
            setError(null);
          }
        })
        .catch((reason) => {
          if (live && alive.current && token === revision.current) setError(describeError(reason));
        })
        .finally(() => {
          polling = false;
        });
    }, 750);
    return () => {
      live = false;
      window.clearInterval(timer);
    };
  }, [project, available, view?.status, describeError]);

  // Начатое действие обесценивает старый опрос; поздний ответ прежнего проекта не меняет новый диалог.
  const perform = useCallback(
    async <T>(action: () => Promise<T>): Promise<T | null> => {
      if (locked.current || !available) return null;
      locked.current = true;
      const token = ++revision.current;
      setWorking(true);
      setError(null);
      try {
        const result = await action();
        return alive.current && token === revision.current ? result : null;
      } catch (reason) {
        if (alive.current && token === revision.current) setError(describeError(reason));
        return null;
      } finally {
        locked.current = false;
        if (alive.current && token === revision.current) setWorking(false);
      }
    },
    [available, describeError]
  );

  const change = async (action: 'view' | 'start' | 'cancel'): Promise<boolean> => {
    const next = await perform(() => window.api.timingAgent[action](project));
    if (!next) return false;
    setView(next);
    return true;
  };
  return { view, error, working, available, reload: () => change('view'), start: () => change('start'), cancel: () => change('cancel'), perform };
}
