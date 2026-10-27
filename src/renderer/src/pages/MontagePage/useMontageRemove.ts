import { useCallback, useEffect, useState } from 'react';
import type { MontageClip } from '@shared/montage';

interface RemoveTarget {
  project: string;
  id: string;
  scene: string;
}

interface Options {
  project: string;
  clip: MontageClip | undefined;
  locked: boolean;
  blocked: boolean;
  onRemove: (id: string) => void;
}

/** Кнопка и Delete используют одну цель подтверждения; смена выделения не переносит удаление на другой фрагмент. */
export function useMontageRemove({ project, clip, locked, blocked, onRemove }: Options) {
  const [pending, setPending] = useState<RemoveTarget | null>(null);
  const clipId = clip?.id;
  const target = !locked && !blocked && pending?.project === project && pending.id === clipId ? pending : null;

  useEffect(() => {
    setPending((current) => (locked || blocked || current?.project !== project || current.id !== clipId ? null : current));
  }, [project, clipId, locked, blocked]);

  const request = useCallback((): void => {
    if (locked || blocked || !clip || pending) return;
    setPending({ project, id: clip.id, scene: clip.scene });
  }, [project, clip, locked, blocked, pending]);

  useEffect(() => {
    const listener = (event: KeyboardEvent): void => {
      if (event.key !== 'Delete' || event.defaultPrevented || event.repeat || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey) return;
      if (locked || blocked || !clipId || pending) return;
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="combobox"], [role="slider"]')
      )
        return;
      // MUI выводит диалоги и меню через portal: проверяем весь документ, а не только предков цели события.
      if (
        Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], [role="menu"], [role="listbox"]')).some(
          (element) => !element.closest('[aria-hidden="true"], [hidden]')
        )
      )
        return;
      event.preventDefault();
      request();
    };
    window.addEventListener('keydown', listener);
    return () => window.removeEventListener('keydown', listener);
  }, [locked, blocked, clipId, pending, request]);

  return {
    target,
    request,
    close: (): void => setPending(null),
    confirm: (): void => {
      setPending(null);
      if (target) onRemove(target.id);
    }
  };
}
