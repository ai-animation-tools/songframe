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

/** Состояние панели и действия над предложением: отдаётся шагам пути целиком. */
export type ProductionWorkflow = ReturnType<typeof useProductionWorkflow>;

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

  /** Применение предложения; follow выполняет решение по применённому материалу в той же операции. */
  const proposal = view?.proposal;
  const apply = useCallback(
    (follow?: (applied: ProductionWorkflowView) => Promise<void>): Promise<boolean> =>
      proposal
        ? execute(
            async () => {
              const applied = await window.api.productionWorkflow.apply(project, shot, packageDir, proposal.id);
              await follow?.(applied);
              return applied;
            },
            true,
            follow ? undefined : productionTexts.useProductionWorkflow.applied
          )
        : Promise.resolve(false),
    [execute, packageDir, project, proposal, shot]
  );

  // Опора агента сразу попадает на карточку с вопросом: решение принимается там, отдельного просмотра нет.
  // Неудачу видно в ошибке панели и окне предложения, поэтому попытка на одно предложение одна.
  const autoApplied = useRef<string | null>(null);
  useEffect(() => {
    if (proposal?.stage !== 'frames' || proposal.status !== 'ready' || proposal.stale || autoApplied.current === proposal.id) return;
    autoApplied.current = proposal.id;
    void apply();
  }, [apply, proposal]);

  return {
    view,
    error,
    busy: pending || !!view?.busy,
    start: (action: ProductionWorkflowStart['action'], note?: string) =>
      execute(() => window.api.productionWorkflow.start({ project, shot, packageDir, action, note })),
    generateFrames: () => (packageDir ? execute(() => window.api.productionWorkflow.generateFrames(project, shot, packageDir)) : Promise.resolve(false)),
    /** Пакет ручной генерации собирается без агента: после записи попытка перечитывается, как после применения. */
    buildManual: () => (packageDir ? execute(() => window.api.productionWorkflow.buildManual(project, shot, packageDir), true) : Promise.resolve(false)),
    /** Свой файл сразу становится кандидатом: вопрос об утверждении откроется у опоры, отдельного просмотра нет. */
    importFrames: (images: ProductionFrameCandidate[]) =>
      packageDir
        ? execute(async () => {
            const next = await window.api.productionWorkflow.importFrames(project, shot, packageDir, images);
            return next.proposal?.status === 'ready' && !next.proposal.stale
              ? window.api.productionWorkflow.apply(project, shot, packageDir, next.proposal.id)
              : next;
          }, true)
        : Promise.resolve(false),
    apply,
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
