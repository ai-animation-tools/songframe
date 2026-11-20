import { useCallback, useRef, useState } from 'react';
import type { SchemesFile } from '@shared/schemes';
import { useApp } from '../../state';

/**
 * Схемы локаций для блока «Точка съёмки»: читаются при первом раскрытии блока и затем живут, пока открыта
 * страница сценария. Сценарий без точек съёмки схемы не читает вовсе.
 */
export function useSchemesOnDemand(): { schemes: SchemesFile | null; error: string | null; loaded: boolean; request(): void } {
  const { state, describeError } = useApp();
  const project = state?.current ?? '';
  const [result, setResult] = useState<{ project: string; schemes: SchemesFile | null; error: string | null } | null>(null);
  const started = useRef<string | null>(null);
  const request = useCallback(() => {
    if (!project || started.current === project) return;
    started.current = project;
    window.api.schemes
      .view(project)
      .then((view) => setResult({ project, schemes: view.damaged ? null : view.document, error: view.damaged ? view.problems.join(' ') : null }))
      .catch((error) => setResult({ project, schemes: null, error: describeError(error) }));
  }, [project, describeError]);
  const current = result?.project === project ? result : null;
  return { schemes: current?.schemes ?? null, error: current?.error ?? null, loaded: !!current, request };
}
