import { useMemo, type ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApp } from '../../state';
import { MontageWorkspace } from './MontageWorkspace';

/** Выбранные на странице сцен планы передаются в начальную пробу, проект задаёт границу состояния. */
export function MontagePage(): ReactElement {
  const { state } = useApp();
  const [params] = useSearchParams();
  const raw = params.get('shots') ?? '';
  const shots = useMemo(
    () => [
      ...new Set(
        raw
          .split(',')
          .map((id) => id.trim())
          .filter(Boolean)
      )
    ],
    [raw]
  );
  // source=M45:plan/batches/M45-attempt-01/request/original.mp4 ставит на дорожку сцены конкретный материал.
  const rawSources = params.getAll('source');
  const preferred = useMemo(() => {
    const result: Record<string, string> = {};
    for (const value of rawSources) {
      const colon = value.indexOf(':');
      if (colon > 0) result[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
    }
    return result;
  }, [rawSources]);
  const project = state?.current ?? '';
  return <MontageWorkspace key={`${project}:${raw}:${rawSources.join('|')}`} project={project} shots={shots} preferred={preferred} />;
}
