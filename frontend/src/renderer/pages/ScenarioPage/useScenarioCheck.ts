import { scenarioTexts } from '@shared/texts/scenario';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScenarioCheckView } from '@shared/scenario-workflow';
import { useApp } from '../../state';

/** Интервал опроса: проверка идёт минуты, отчёт и признак устаревания меняются от сохранений на странице. */
const POLL_MS = 1000;

/**
 * Проверка сценария агентом: последний отчёт проекта, запуск и остановка задания. Опрос восстанавливает
 * идущую проверку после перезапуска и сам замечает, что сохранение сценария сделало отчёт устаревшим.
 * Итог завершившейся проверки дублируется в Snackbar: пользователь может быть далеко внизу страницы.
 */
export function useScenarioCheck(project: string) {
  const { describeError, notify } = useApp();
  const [view, setView] = useState<ScenarioCheckView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  const lastStatus = useRef<ScenarioCheckView['status'] | null>(null);

  useEffect(() => {
    setView(null);
    setError(null);
    setPending(false);
    lastStatus.current = null;
  }, [project]);

  useEffect(() => {
    const status = view?.status ?? null;
    if (lastStatus.current === 'running' && status && status !== 'running' && status !== 'none') {
      if (status === 'ready') notify(scenarioTexts.check.finished({ count: view?.report?.issues.length ?? 0 }), 'success');
      else if (status !== 'cancelled') notify(scenarioTexts.check.finishedFailed, 'warning');
    }
    lastStatus.current = status;
  }, [view, notify]);

  const read = useCallback(async (): Promise<void> => {
    const revision = generation.current;
    try {
      const next = await window.api.scenarioWorkflow.checkView(project);
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
    async (operation: () => Promise<ScenarioCheckView>): Promise<void> => {
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
    start: () => run(() => window.api.scenarioWorkflow.startCheck(project)),
    cancel: async (id: string): Promise<void> => {
      await run(async () => {
        await window.api.agents.cancel(id);
        return window.api.scenarioWorkflow.checkView(project);
      });
    }
  };
}
