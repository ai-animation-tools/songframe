import { scenarioTexts } from '@shared/texts/scenario';
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScenarioCheckFixPreview, ScenarioCheckView } from '@shared/scenario-workflow';
import { useApp } from '../../state';

/** Интервал опроса: проверка идёт минуты, отчёт и признак устаревания меняются от сохранений на странице. */
const POLL_MS = 1000;

/**
 * Проверка сценария агентом: последний отчёт проекта, запуск и остановка задания. Опрос восстанавливает
 * идущую проверку после перезапуска и сам замечает, что сохранение сценария сделало отчёт устаревшим.
 * Итог завершившейся проверки дублируется в Snackbar: пользователь может быть далеко внизу страницы.
 * Правки проблем записывают сценарий, поэтому после них страница перечитывает его (onFixed).
 */
export function useScenarioCheck(project: string, onFixed: () => Promise<void>) {
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
    async (operation: () => Promise<ScenarioCheckView>): Promise<boolean> => {
      const revision = ++generation.current;
      setPending(true);
      setError(null);
      try {
        const next = await operation();
        if (generation.current === revision) setView(next);
        return generation.current === revision;
      } catch (reason) {
        if (generation.current === revision) setError(describeError(reason));
        return false;
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
    /** Правки выбранных проблем и задетые планы, без записи; ошибку показывает окно исправления. */
    preview: (issues: number[]): Promise<ScenarioCheckFixPreview> => window.api.scenarioWorkflow.checkFixPreview(project, issues),
    /** Запись правок; принятые планы keep остаются принятыми. Возвращает успех: окно закрывается только после записи. */
    applyFixes: async (issues: number[], keep: string[]): Promise<boolean> => {
      const done = await run(() => window.api.scenarioWorkflow.applyCheckFixes({ project, issues, keep }));
      if (done) {
        await onFixed();
        notify(scenarioTexts.check.applied({ count: issues.length }), 'success');
      }
      return done;
    },
    /** Отметка «Решено вручную» у проблемы или её снятие. */
    resolve: (issue: number, resolved: boolean) => run(() => window.api.scenarioWorkflow.resolveCheckIssue({ project, issue, resolved })),
    /**
     * Отметка «Решено вручную» сразу у нескольких проблем: тот же вызов, что и по одной, последовательно,
     * потому что каждая отметка перезаписывает запись проверки. При ошибке уже поставленные отметки
     * остаются, а опрос покажет фактическое состояние отчёта.
     */
    resolveAll: (issues: number[]) =>
      run(async () => {
        let next: ScenarioCheckView | null = null;
        for (const issue of issues) next = await window.api.scenarioWorkflow.resolveCheckIssue({ project, issue, resolved: true });
        return next ?? window.api.scenarioWorkflow.checkView(project);
      }),
    cancel: async (id: string): Promise<void> => {
      await run(async () => {
        await window.api.agents.cancel(id);
        return window.api.scenarioWorkflow.checkView(project);
      });
    }
  };
}
