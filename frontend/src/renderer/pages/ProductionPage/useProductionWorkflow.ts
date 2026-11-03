import { productionTexts } from '@shared/texts/production';
/** Опрос выбранного пакета не переносит ответы агента между планами и не перекрывает применение предложения. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductionFrameCandidate, ProductionWorkflowStart, ProductionWorkflowView } from '@shared/production-workflow';
import { useApp } from '../../state';
import { PRODUCTION_PASS_LABELS } from './constants';

type Notify = ReturnType<typeof useApp>['notify'];

/** Состояние предложения и задания, по смене которого сообщаем о завершении работы агента. */
interface Observed {
  proposal: string;
  job: string;
}

const observe = (view: ProductionWorkflowView): Observed => ({
  proposal: view.proposal ? `${view.proposal.id}\0${view.proposal.status}` : '',
  job: view.job ? `${view.job.id}\0${view.job.status}` : ''
});

/**
 * Панель закреплённой колонки может быть прокручена вне вида: завершение агента сообщается через Snackbar.
 * Первый снимок пакета только запоминается, чтобы открытие пакета с готовым предложением не вызывало уведомлений.
 */
function announce(previous: Observed | null, view: ProductionWorkflowView, notify: Notify): void {
  if (!previous) return;
  const current = observe(view);
  const { proposal, job } = view;
  if (proposal && current.proposal !== previous.proposal) {
    const stage = PRODUCTION_PASS_LABELS[proposal.stage];
    if (proposal.status === 'ready') notify(productionTexts.useProductionWorkflow.proposalReady({ stage }), 'success');
    else if (proposal.status === 'invalid' && proposal.refused) notify(productionTexts.useProductionWorkflow.proposalRefused({ stage }), 'warning');
    else if (proposal.status === 'invalid') notify(productionTexts.useProductionWorkflow.proposalInvalid({ stage, message: proposal.message }), 'warning');
    // Пользователь сам нажал «Остановить»: это подтверждение, а не ошибка.
    else if (proposal.status === 'cancelled') notify(productionTexts.useProductionWorkflow.proposalCancelled({ stage }), 'info');
    else if (proposal.status === 'failed' || proposal.status === 'interrupted')
      notify(productionTexts.useProductionWorkflow.proposalFailed({ stage, failed: proposal.status === 'failed', message: proposal.message }), 'error');
  } else if (!proposal && job && current.job !== previous.job && (job.status === 'failed' || job.status === 'interrupted')) {
    notify(productionTexts.useProductionWorkflow.jobFailed({ task: job.task, failed: job.status === 'failed' }), 'error');
  }
}

export function useProductionWorkflow(project: string, shot: string, packageDir: string | undefined, onApplied: (packageDir: string | null) => Promise<void>) {
  const { describeError, notify } = useApp();
  const [view, setView] = useState<ProductionWorkflowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const context = `${project}\0${shot}\0${packageDir ?? ''}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  const revision = useRef(0);
  const mutating = useRef(false);
  const observed = useRef<Observed | null>(null);
  const show = useCallback(
    (next: ProductionWorkflowView) => {
      announce(observed.current, next, notify);
      observed.current = observe(next);
      setView(next);
    },
    [notify]
  );
  const invalidate = useCallback(() => {
    revision.current++;
  }, []);

  useEffect(() => {
    let active = true;
    invalidate();
    let timer: ReturnType<typeof setTimeout>;
    setView(null);
    setError(null);
    setPending(false);
    mutating.current = false;
    observed.current = null;
    const read = async (): Promise<void> => {
      const version = revision.current;
      try {
        if (!mutating.current) {
          const next = await window.api.productionWorkflow.view(project, shot, packageDir);
          if (active && contextRef.current === context && version === revision.current && !mutating.current) {
            show(next);
            setError(null);
          }
        }
      } catch (reason) {
        // Устаревшая ошибка чтения так же неактуальна, как его успешный ответ: новая операция уже сменила revision.
        if (active && contextRef.current === context && version === revision.current && !mutating.current) setError(describeError(reason));
      } finally {
        if (active) timer = setTimeout(() => void read(), 1500);
      }
    };
    void read();
    return () => {
      active = false;
      invalidate();
      clearTimeout(timer);
    };
  }, [context, project, shot, packageDir, describeError, invalidate, show]);

  const execute = useCallback(
    async (operation: () => Promise<ProductionWorkflowView>, applied = false, done?: string): Promise<boolean> => {
      if (mutating.current) return false;
      mutating.current = true;
      const version = ++revision.current;
      setPending(true);
      setError(null);
      try {
        const next = await operation();
        // Ответ старого проекта или пакета не должен менять уже выбранный пользователем контекст.
        if (contextRef.current !== context || version !== revision.current) return false;
        show(next);
        if (applied) await onApplied(next.packageDir);
        if (done) notify(done, applied ? 'success' : 'info');
        return true;
      } catch (reason) {
        if (contextRef.current === context && version === revision.current) {
          // Ошибка остаётся у кнопок панели и дублируется в Snackbar: кнопки могут быть вне вида.
          const message = describeError(reason);
          setError(message);
          notify(message, 'error');
        }
        return false;
      } finally {
        if (contextRef.current === context && version === revision.current) {
          mutating.current = false;
          setPending(false);
        }
      }
    },
    [context, describeError, notify, onApplied, show]
  );

  return {
    view,
    error,
    busy: pending || !!view?.busy,
    start: (action: ProductionWorkflowStart['action'], note?: string) =>
      execute(() => window.api.productionWorkflow.start({ project, shot, packageDir, action, note })),
    generateFrames: () => (packageDir ? execute(() => window.api.productionWorkflow.generateFrames(project, shot, packageDir)) : Promise.resolve(false)),
    importFrames: (images: ProductionFrameCandidate[]) =>
      packageDir ? execute(() => window.api.productionWorkflow.importFrames(project, shot, packageDir, images)) : Promise.resolve(false),
    apply: () =>
      view?.proposal
        ? execute(() => window.api.productionWorkflow.apply(project, shot, packageDir, view.proposal!.id), true, productionTexts.useProductionWorkflow.applied)
        : Promise.resolve(false),
    discard: () =>
      view?.proposal
        ? execute(
            () => window.api.productionWorkflow.discard(project, shot, packageDir, view.proposal!.id),
            false,
            productionTexts.useProductionWorkflow.discarded
          )
        : Promise.resolve(false),
    cancel: async (id: string): Promise<void> => {
      await execute(async () => {
        await window.api.agents.cancel(id);
        return window.api.productionWorkflow.view(project, shot, packageDir);
      });
    }
  };
}
