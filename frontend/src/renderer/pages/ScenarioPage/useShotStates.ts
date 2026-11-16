import { useEffect, useState } from 'react';
import type { ShotProductionState } from '@shared/types';
import { useApp } from '../../state';

/**
 * Статусы производства планов для страницы «Сценарий»: бейджи списка планов и раскраска шкалы по статусу.
 * Статус считает Go по сохранённому реестру (production.view); после сохранения оболочка обновляет state,
 * и статусы перечитываются. null — статусы ещё не загружены или недоступны: тогда бейджей нет, а шкала
 * считает планы не начатыми.
 */
export function useShotStates(): Record<string, ShotProductionState> | null {
  const { state } = useApp();
  const project = state?.current ?? '';
  const [states, setStates] = useState<Record<string, ShotProductionState> | null>(null);
  useEffect(() => {
    if (!project) return;
    let cancelled = false;
    window.api.production
      .view(project)
      .then((view) => {
        if (!cancelled) setStates(Object.fromEntries(view.shots.map((shot) => [shot.id, shot.state])));
      })
      .catch(() => {
        if (!cancelled) setStates(null);
      });
    return () => {
      cancelled = true;
    };
  }, [project, state]);
  return states;
}
