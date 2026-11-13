import { useCallback, useEffect, useRef, useState } from 'react';
import type { JobInfo } from '@shared/types';
import { VOCAL_MODELS, type VocalModelId, type VocalPreparationView } from '@shared/vocals';
import { songTimingTexts as texts } from '@shared/texts/song-timing';
import { useApp } from '../../../state';

interface Props {
  project: string;
  onReady(ready: boolean): void;
  onJob(job: JobInfo | null): void;
  onBusy?(busy: boolean): void;
}

/** Кэш читает Go; новый запуск никогда не сбрасывает прежние варианты и явный выбор. */
export function useVocalPreparation({ project, onReady, onJob, onBusy }: Props) {
  const { describeError } = useApp();
  const [view, setView] = useState<VocalPreparationView | null>(null);
  const [job, setJob] = useState<JobInfo | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(true);
  const mounted = useRef(false);
  const operation = useRef(false);
  const request = useRef(Symbol());
  const readError = useRef(false);
  const update = useCallback(
    (next: VocalPreparationView) => {
      setView(next);
      onReady(!!next.sourceSha256 && !!next.selectedId && next.results.some((item) => item.id === next.selectedId));
    },
    [onReady]
  );
  const read = useCallback(async () => {
    const revision = Symbol();
    request.current = revision;
    try {
      const next = await window.api.timing.vocalsView(project);
      if (mounted.current && request.current === revision) {
        update(next);
        // Успешное чтение снимает только свой сбой; ошибку выделения или отмены сохраняем.
        if (readError.current) {
          readError.current = false;
          setError('');
        }
      }
    } catch (reason) {
      if (mounted.current && request.current === revision) {
        readError.current = true;
        onReady(false);
        setError(describeError(reason));
      }
    }
  }, [project, update, onReady, describeError]);
  useEffect(() => {
    mounted.current = true;
    onReady(false);
    onBusy?.(true);
    void Promise.all([read(), window.api.jobs.list()])
      .then(([, jobs]) => {
        if (!mounted.current) return;
        const current =
          jobs.find(
            (item) =>
              item.status === 'running' &&
              ((item.project === project && item.steps.some((step) => step.tool === 'separate_vocals')) ||
                VOCAL_MODELS.some((model) => model.id === item.modelDownload?.model))
          ) ?? null;
        setJob(current);
        onJob(current);
      })
      .catch((reason) => {
        if (mounted.current) {
          readError.current = false;
          setError(describeError(reason));
        }
      })
      .finally(() => {
        if (mounted.current) {
          setBusy(false);
          onBusy?.(false);
        }
      });
    return () => {
      mounted.current = false;
      request.current = Symbol();
      onReady(false);
      onJob(null);
      onBusy?.(false);
    };
  }, [project, read, onReady, onJob, onBusy, describeError]);
  useEffect(() => {
    let polling = false;
    const refresh = async (): Promise<void> => {
      if (polling || operation.current) return;
      polling = true;
      try {
        if (job?.status === 'running') {
          const next = await window.api.jobs.get(job.id);
          if (!mounted.current) return;
          setJob(next);
          onJob(next);
          if (!next || next.status === 'failed' || next.status === 'interrupted') {
            readError.current = false;
            setError(next?.error || texts.vocalJobMissing);
          }
          if (next?.status === 'running') return;
        }
        await read();
      } catch (reason) {
        if (mounted.current) {
          readError.current = false;
          setError(describeError(reason));
        }
      } finally {
        polling = false;
      }
    };
    const timer = setInterval(() => void refresh(), 1000);
    window.addEventListener('focus', refresh);
    return () => {
      clearInterval(timer);
      window.removeEventListener('focus', refresh);
    };
  }, [job?.id, job?.status, read, onJob, describeError]);
  const act = async (action: () => Promise<JobInfo | VocalPreparationView>, invalidateOnError = false): Promise<boolean> => {
    if (operation.current || busy) return false;
    operation.current = true;
    request.current = Symbol();
    setBusy(true);
    onBusy?.(true);
    readError.current = false;
    setError('');
    try {
      const next = await action();
      if (!mounted.current) return false;
      if ('results' in next) update(next);
      else {
        setJob(next);
        onJob(next);
        if (next.status !== 'running') await read();
      }
      return true;
    } catch (reason) {
      if (mounted.current) {
        readError.current = invalidateOnError;
        if (invalidateOnError) onReady(false);
        setError(describeError(reason));
      }
      return false;
    } finally {
      operation.current = false;
      if (mounted.current) {
        setBusy(false);
        onBusy?.(false);
      }
    }
  };
  return {
    view,
    job,
    error,
    busy,
    refresh: () =>
      act(async () => {
        const next = await window.api.timing.vocalsView(project);
        return next;
      }, true),
    download: (model: VocalModelId) => act(() => window.api.timing.downloadVocalModel(model)),
    separate: (model: VocalModelId) => act(() => window.api.timing.separateVocals(project, model)),
    select: (id: string) => act(() => window.api.timing.selectVocal(project, id), true),
    // Удаление меняет выбор только по подтверждённому ответу Go; ошибка сохраняет прежний view.
    remove: (id: string) => act(() => window.api.timing.deleteVocal(project, id)),
    cancel: () =>
      act(async () => {
        if (!job) throw new Error(texts.vocalJobMissing);
        let next = await window.api.timing.cancel(job.id);
        while (next.status === 'running') {
          await new Promise((resolve) => setTimeout(resolve, 250));
          const value = await window.api.jobs.get(job.id);
          if (!value) throw new Error(texts.vocalJobMissing);
          next = value;
        }
        return next;
      })
  };
}
