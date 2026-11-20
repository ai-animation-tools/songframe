import { commonTexts } from '@shared/texts/common';
import { useCallback, useEffect, useRef, useState } from 'react';
import { draftEnvelope, parseDraft, type DraftEnvelope, type DraftKind } from '@shared/drafts';

/** Задержка записи после правки, мс: перетаскивание точки не пишет файл на каждый сдвиг. */
const WRITE_DELAY = 500;

/** Найденный при открытии черновик: документ, время записи и признак, что сохранённый файл с тех пор изменился. */
export interface DraftOffer<T> {
  envelope: DraftEnvelope<T>;
  baseChanged: boolean;
}

/**
 * Страховка несохранённых правок страницы во временном файле каталога состояния (`projects.*Draft`).
 *
 * При открытии (ready — сохранённый документ загружен) читает черновик проекта: совпавший с сохранённым или
 * повреждённый удаляется, иначе становится предложением offer — страница показывает DraftRestoreAlert. Пока
 * предложение не принято и не отброшено, черновик не перезаписывается. Дальше каждая правка (dirty) пишется с
 * задержкой WRITE_DELAY, а возврат к сохранённому — после записи или отмены правок — удаляет файл. Операции с
 * файлом выполняются строго по очереди, чтобы удаление после сохранения не обогнала запоздавшая запись. Уход со
 * страницы дописывает отложенную запись. Ошибка записи сообщается один раз: страница работает и без страховки.
 */
export function useDraftBackup<T>({
  project,
  kind,
  ready,
  saved,
  draft,
  dirty,
  onRestore,
  onError
}: {
  project: string;
  kind: DraftKind;
  ready: boolean;
  /** Сохранённый документ: основа черновика. */
  saved: unknown;
  draft: T;
  dirty: boolean;
  onRestore(document: T): void;
  onError(message: string): void;
}): { offer: DraftOffer<T> | null; restore(): void; discard(): void } {
  const [checked, setChecked] = useState<string | null>(null);
  const [offer, setOffer] = useState<DraftOffer<T> | null>(null);
  const queue = useRef<Promise<unknown>>(Promise.resolve());
  const written = useRef(false);
  const pending = useRef<string | null>(null);
  const reported = useRef(false);
  const errorRef = useRef(onError);
  errorRef.current = onError;
  const projectRef = useRef(project);
  projectRef.current = project;

  const enqueue = useCallback((target: string, operation: () => Promise<void>): void => {
    queue.current = queue.current.then(operation).catch((error: unknown) => {
      if (reported.current || target !== projectRef.current) return;
      reported.current = true;
      errorRef.current(commonTexts.draft.writeFailed({ error: error instanceof Error ? error.message : String(error) }));
    });
  }, []);
  const write = useCallback(
    (target: string, content: string) => {
      written.current = true;
      enqueue(target, () => window.api.projects.writeDraft(target, kind, content));
    },
    [enqueue, kind]
  );
  const remove = useCallback(
    (target: string) => {
      written.current = false;
      enqueue(target, () => window.api.projects.removeDraft(target, kind));
    },
    [enqueue, kind]
  );

  // Чтение черновика один раз на проект, когда сохранённый документ уже известен.
  const savedRef = useRef(saved);
  savedRef.current = saved;
  useEffect(() => {
    if (!ready || !project || checked === project) return;
    let cancelled = false;
    setOffer(null);
    window.api.projects
      .readDraft(project, kind)
      .then((content) => {
        if (cancelled) return;
        const envelope = parseDraft<T>(content);
        const base = JSON.stringify(savedRef.current ?? null);
        if (envelope && JSON.stringify(envelope.document ?? null) !== base) {
          written.current = true;
          setOffer({ envelope, baseChanged: envelope.base !== base });
        } else if (content) remove(project);
        setChecked(project);
      })
      .catch(() => {
        // Нечитаемый каталог состояния не мешает работе: страница просто без восстановления.
        if (!cancelled) setChecked(project);
      });
    return () => {
      cancelled = true;
    };
  }, [ready, project, kind, checked, remove]);

  // Запись правок с задержкой; без правок — удаление ранее записанного черновика.
  const active = checked === project && !offer;
  useEffect(() => {
    if (!active) return;
    if (!dirty) {
      pending.current = null;
      if (written.current) remove(project);
      return;
    }
    const content = draftEnvelope(draft, saved);
    pending.current = content;
    const handle = setTimeout(() => {
      pending.current = null;
      write(project, content);
    }, WRITE_DELAY);
    return () => clearTimeout(handle);
  }, [active, dirty, draft, saved, project, write, remove]);

  // Уход со страницы или смена проекта: отложенная запись не теряется.
  useEffect(
    () => () => {
      if (pending.current) write(project, pending.current);
      pending.current = null;
    },
    [project, write]
  );

  const restore = (): void => {
    if (!offer) return;
    onRestore(offer.envelope.document);
    setOffer(null);
  };
  const discard = (): void => {
    setOffer(null);
    remove(project);
  };
  return { offer, restore, discard };
}
