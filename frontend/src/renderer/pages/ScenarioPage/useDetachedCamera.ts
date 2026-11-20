import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { CameraWindowState } from '@shared/camera-window';

/**
 * Отдельное окно вида из камеры для карты точки съёмки. Карта — владелец: она присылает окну состояние, когда окно
 * сообщит о готовности, и после каждого изменения точки, схемы, роста героев или темы. Окно ничего не правит.
 * Размонтирование карты (закрытие её окна во весь экран) закрывает и отдельное окно; закрытие отдельного окна
 * возвращает вид из камеры в карту.
 */
export function useDetachedCamera(state: CameraWindowState, onError: (error: unknown) => void): { detached: boolean; open(): void; close(): void } {
  const current = useRef({ state, onError });
  current.current = { state, onError };
  const session = useRef<string | null>(null);
  const ready = useRef(false);
  const [detached, setDetached] = useState(false);

  useEffect(() => {
    const api = window.api.cameraWindow;
    const unsubscribe = api.onMessage(({ session: id, message }) => {
      if (id !== session.current || message.type !== 'ready') return;
      ready.current = true;
      api.send({ type: 'state', state: current.current.state });
    });
    const unsubscribeClosed = api.onClosed((id) => {
      if (id !== session.current) return;
      session.current = null;
      ready.current = false;
      setDetached(false);
    });
    return () => {
      unsubscribe();
      unsubscribeClosed();
      const id = session.current;
      session.current = null;
      ready.current = false;
      if (id) void api.close(id).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    if (ready.current && session.current) window.api.cameraWindow.send({ type: 'state', state: current.current.state });
  }, [state.title, state.scheme, state.viewpoint, state.heights, state.theme]);

  const open = (): void => {
    if (session.current) return;
    const id = crypto.randomUUID();
    session.current = id;
    ready.current = false;
    // Встроенные кадры уходят до открытия окна: два контекста WebGL одной сцены не нужны.
    flushSync(() => setDetached(true));
    void window.api.cameraWindow.open(id).catch((error: unknown) => {
      if (session.current === id) {
        session.current = null;
        setDetached(false);
      }
      current.current.onError(error);
    });
  };
  const close = (): void => {
    const id = session.current;
    if (id) void window.api.cameraWindow.close(id).catch((error: unknown) => current.current.onError(error));
  };
  return { detached, open, close };
}
