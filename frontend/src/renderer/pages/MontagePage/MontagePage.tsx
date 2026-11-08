import { useMemo, type ReactElement } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useApp } from '../../state';
import { MontageWorkspace } from './MontageWorkspace';

/** Монтаж: ручная проба из принятых планов, её черновики, экспорт и применение к сценам.
 *
 * Выбранные на странице сцен планы передаются в начальную пробу, проект задаёт границу состояния. */
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
  // Зависимость — строка, а не массив: getAll даёт новый массив на каждую перерисовку, а новый preferred
  // перезапускал чтение в useMontage и сбрасывал несохранённую пробу при любом обновлении статуса приложения.
  const rawSources = params.getAll('source').join('\n');
  const preferred = useMemo(() => {
    const result: Record<string, string> = {};
    for (const value of rawSources.split('\n')) {
      const colon = value.indexOf(':');
      if (colon > 0) result[value.slice(0, colon).trim()] = value.slice(colon + 1).trim();
    }
    return result;
  }, [rawSources]);
  const project = state?.current ?? '';
  return <MontageWorkspace key={`${project}:${raw}:${rawSources}`} project={project} shots={shots} preferred={preferred} />;
}
