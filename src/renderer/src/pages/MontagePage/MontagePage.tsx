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
  const project = state?.current ?? '';
  return <MontageWorkspace key={`${project}:${raw}`} project={project} shots={shots} />;
}
