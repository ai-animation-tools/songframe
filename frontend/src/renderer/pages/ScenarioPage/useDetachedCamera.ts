import { useEffect, useRef, useState } from 'react';
import type { CameraWindowState } from '@shared/camera-window';

/**
 * Отдельное окно вида из камеры для карты точки съёмки. Карта — владелец: она присылает окну состояние, когда окно
 * сообщит о готовности, и после каждого изменения точки, схемы, роста героев или темы. Из окна приходит зум
 * объектива — его применяет onFov. Состояние null (карта закрыта, у локации нет схемы) закрывает окно; размонтирование
 * владельца тоже. Закрытие окна крестиком возвращает detached в false.
 */
export function useDetachedCamera(
  state: CameraWindowState | null,
  handlers: { onFov(fov: number): void; onError(error: unknown): void }
): { detached: boolean; open(): void; close(): void } {
  const current = useRef({ state, handlers });
  current.current = { state, handlers };
  const session = useRef<string | null>(null);
  const ready = useRef(false);
  const [detached, setDetached] = useState(false);

  useEffect(() => {
    const api = window.api.cameraWindow;
    const unsubscribe = api.onMessage(({ session: id, message }) => {
      if (id !== session.current) return;
      if (message.type === 'ready') {
        ready.current = true;
        if (current.current.state) api.send({ type: 'state', state: current.current.state });
      } else if (message.type === 'fov') {
        current.current.handlers.onFov(message.fov);
      }
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

  const close = (): void => {
    const id = session.current;
    if (id) void window.api.cameraWindow.close(id).catch((error: unknown) => current.current.handlers.onError(error));
  };

  useEffect(() => {
    if (!state) {
      close();
      return;
    }
    if (ready.current && session.current) window.api.cameraWindow.send({ type: 'state', state });
    // close читает только ref-ы, поэтому в зависимостях не нужен.
  }, [state]);

  const open = (): void => {
    if (session.current || !current.current.state) return;
    const id = crypto.randomUUID();
    session.current = id;
    ready.current = false;
    setDetached(true);
    void window.api.cameraWindow.open(id).catch((error: unknown) => {
      if (session.current === id) {
        session.current = null;
        setDetached(false);
      }
      current.current.handlers.onError(error);
    });
  };
  return { detached, open, close };
}
