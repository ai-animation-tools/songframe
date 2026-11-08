import { useEffect, useRef, useState } from 'react';
import { flushSync } from 'react-dom';
import type { MontageWindowState } from '@shared/montage-window';

interface Callbacks {
  onFrame(frame: number): void;
  onMetadata(path: string, frames: number): void;
  onTrackFrames(frames: number): void;
  onPreferences(loop: boolean, volume: number): void;
  onError(error: unknown): void;
}

/** Черновик принадлежит странице; единственные часы воспроизведения находятся в открытом плеере. */
export function useDetachedMontage(snapshot: MontageWindowState, callbacks: Callbacks) {
  const current = useRef({ snapshot, callbacks });
  current.current = { snapshot, callbacks };
  const session = useRef<string | null>(null);
  const opening = useRef<string | null>(null);
  const ready = useRef(false);
  const [detached, setDetached] = useState(false);

  useEffect(() => {
    const api = window.api.montageWindow;
    const unsubscribe = api.onMessage(({ session: id, message }) => {
      if (id !== session.current) return;
      if (message.type === 'ready') {
        ready.current = true;
        api.send({ type: 'state', state: current.current.snapshot });
      } else if (message.type === 'frame') current.current.callbacks.onFrame(message.frame);
      else if (message.type === 'metadata') current.current.callbacks.onMetadata(message.path, message.frames);
      else if (message.type === 'trackFrames') current.current.callbacks.onTrackFrames(message.frames);
      else if (message.type === 'preferences') current.current.callbacks.onPreferences(message.loop, message.volume);
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
      opening.current = null;
      ready.current = false;
      if (id) void api.close(id).catch(() => undefined);
    };
  }, []);

  useEffect(() => {
    // Обновления положения от плеера не отправляются обратно: явная перемотка меняет seekVersion.
    if (ready.current && session.current) window.api.montageWindow.send({ type: 'state', state: current.current.snapshot });
  }, [
    snapshot.project,
    snapshot.draft,
    snapshot.trackUrl,
    snapshot.seekVersion,
    snapshot.selectedClipId,
    snapshot.suspended,
    snapshot.theme,
    snapshot.loop,
    snapshot.volume
  ]);

  useEffect(() => {
    if (!detached || snapshot.suspended) return;
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.ctrlKey || event.metaKey || event.altKey) return;
      if ((event.target as HTMLElement)?.closest('input, textarea, select, button, [role="dialog"], [role="slider"], [contenteditable="true"]')) return;
      const action = event.code === 'Space' ? 'toggle' : event.key === 'ArrowLeft' ? 'previousFrame' : event.key === 'ArrowRight' ? 'nextFrame' : null;
      if (!action || !ready.current) return;
      event.preventDefault();
      window.api.montageWindow.send({ type: 'command', action });
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [detached, snapshot.suspended]);

  const open = (): void => {
    if (session.current) return;
    const id = crypto.randomUUID();
    session.current = id;
    opening.current = id;
    ready.current = false;
    // Сначала размонтируем встроенный плеер, чтобы второе окно не запустилось одновременно с ним.
    flushSync(() => setDetached(true));
    void window.api.montageWindow.open(id).then(
      () => {
        if (opening.current === id) opening.current = null;
      },
      (error: unknown) => {
        if (opening.current !== id) return;
        opening.current = null;
        if (session.current === id) {
          session.current = null;
          ready.current = false;
          setDetached(false);
        }
        current.current.callbacks.onError(error);
      }
    );
  };
  const close = (): void => {
    const id = session.current;
    if (id) {
      if (opening.current === id) opening.current = null;
      void window.api.montageWindow.close(id).catch((error: unknown) => current.current.callbacks.onError(error));
    }
  };
  return { detached, open, close };
}
