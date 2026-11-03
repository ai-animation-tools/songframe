import { useEffect, type ReactNode } from 'react';

interface Props {
  children: ReactNode;
  onReady: () => Promise<void>;
  onError: (error: unknown) => void;
}

/** Подтверждает готовность только после успешного commit всего содержимого внутри RenderBoundary.
 * Если потомок падает при рендере, React не монтирует эту ветку и не запускает эффект: smoke не получает ложный успех.
 * После unmount отбрасываются отложенное подтверждение и ошибка уже начатого вызова.
 */
export function ReadyContent({ children, onReady, onError }: Props) {
  useEffect(() => {
    let active = true;
    void Promise.resolve()
      .then(() => {
        if (active) return onReady();
      })
      .catch((error: unknown) => {
        if (active) onError(error);
      });
    return () => {
      active = false;
    };
  }, [onReady, onError]);
  return children;
}
