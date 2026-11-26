import { useCallback, useEffect, useRef, useState } from 'react';
import { castTexts } from '@shared/texts/cast';
import type { ReferenceAdviceView } from '@shared/scenario-workflow';
import { useApp } from '../state';

/** Интервал опроса: совет готовится минуты, а признак устаревания меняется от сохранений на других страницах. */
const POLL_MS = 1000;

/**
 * Рекомендации агента по референсам проекта: последний совет, запуск, остановка и сохранение в файл. Опрос
 * восстанавливает идущее задание после перезапуска; итог завершившегося задания дублируется в Snackbar.
 * Совет общий для «Кастинга» и «Исходников»: обе страницы читают одну запись проекта.
 */
export function useReferenceAdvice(project: string) {
  const { describeError, notify } = useApp();
  const [view, setView] = useState<ReferenceAdviceView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const lastStatus = useRef<ReferenceAdviceView['status'] | null>(null);

  useEffect(() => {
    setView(null);
    setError(null);
    setPending(false);
    lastStatus.current = null;
  }, [project]);

  useEffect(() => {
    const status = view?.status ?? null;
    if (lastStatus.current === 'running' && status && status !== 'running' && status !== 'none') {
      if (status === 'ready') notify(castTexts.advice.finished, 'success');
      else if (status !== 'cancelled') notify(castTexts.advice.finishedFailed, 'warning');
    }
    lastStatus.current = status;
  }, [view, notify]);

  const read = useCallback(async (): Promise<void> => {
    const revision = generation.current;
    try {
      const next = await window.api.scenarioWorkflow.adviceView(project);
      // Ответ старого проекта или запроса до запуска не перекрывает новое состояние.
      if (generation.current !== revision) return;
      setView((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
    } catch (reason) {
      if (generation.current === revision) setError(describeError(reason));
    }
  }, [project, describeError]);

  useEffect(() => {
    generation.current++;
    let reading = false;
    const tick = (): void => {
      if (reading) return;
      reading = true;
      void read().finally(() => {
        reading = false;
      });
    };
    tick();
    const timer = setInterval(tick, POLL_MS);
    return () => {
      generation.current++;
      clearInterval(timer);
    };
  }, [read]);

  const run = useCallback(
    async (operation: () => Promise<ReferenceAdviceView>): Promise<void> => {
      const revision = ++generation.current;
      setPending(true);
      setError(null);
      try {
        const next = await operation();
        if (generation.current === revision) setView(next);
      } catch (reason) {
        if (generation.current === revision) setError(describeError(reason));
      } finally {
        if (generation.current === revision) setPending(false);
      }
    },
    [describeError]
  );

  return {
    view,
    error,
    pending,
    start: () => run(() => window.api.scenarioWorkflow.startAdvice(project)),
    cancel: async (id: string): Promise<void> => {
      await run(async () => {
        await window.api.agents.cancel(id);
        return window.api.scenarioWorkflow.adviceView(project);
      });
    },
    /** Текст рекомендаций в файл из системного диалога; отмена диалога ничего не сообщает. */
    save: async (): Promise<void> => {
      try {
        const path = await window.api.scenarioWorkflow.saveAdvice(project);
        if (path) notify(castTexts.advice.saved({ path }), 'success');
      } catch (reason) {
        notify(describeError(reason), 'error');
      }
    }
  };
}
