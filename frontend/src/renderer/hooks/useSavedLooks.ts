import { useCallback, useEffect, useRef, useState } from 'react';
import type { SavedLooksView } from '@shared/saved-looks';
import { useApp } from '../state';

/**
 * Сохранённые образы проекта: статусы загружаются сами при открытии страницы и при смене revision (после
 * сохранения исходников меняются снимки, а с ними — «устарел»), без ручной кнопки проверки. Действия окна
 * образа возвращают новое состояние целиком. Общий для «Исходников» и «Кастинга».
 */
export function useSavedLooks(project: string | null, revision?: string) {
  const { describeError } = useApp();
  const [view, setView] = useState<SavedLooksView | null>(null);
  const [loading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState<string | null>(null);
  const generation = useRef(0);

  useEffect(() => {
    const current = ++generation.current;
    if (!project) {
      setView(null);
      return;
    }
    setLoading(true);
    setLoadError(null);
    window.api.savedLooks
      .view(project)
      .then((next) => {
        if (generation.current === current) setView(next);
      })
      .catch((reason: unknown) => {
        if (generation.current === current) setLoadError(describeError(reason));
      })
      .finally(() => {
        if (generation.current === current) setLoading(false);
      });
    return () => {
      // Поздний ответ после смены проекта или размонтирования не перекрывает новое состояние.
      generation.current++;
    };
  }, [project, revision, describeError]);

  /** Выполняет действие окна образа и принимает его итог; ошибка — текстом для окна, состояние прежнее. */
  const run = useCallback(
    async (action: (project: string) => Promise<SavedLooksView>): Promise<string | null> => {
      if (!project) return null;
      const current = generation.current;
      try {
        const next = await action(project);
        if (generation.current === current) setView(next);
        return null;
      } catch (reason) {
        return describeError(reason);
      }
    },
    [project, describeError]
  );

  return { view, loading, loadError, run };
}
