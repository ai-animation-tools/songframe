/** Опрос выбранного пакета не переносит ответы агента между планами и не перекрывает применение предложения. */
import { useCallback, useEffect, useRef, useState } from 'react';
import type { ProductionFrameCandidate, ProductionWorkflowStart, ProductionWorkflowView } from '@shared/production-workflow';
import { useApp } from '../../state';

export function useProductionWorkflow(project: string, shot: string, packageDir: string | undefined, onApplied: (packageDir: string | null) => Promise<void>) {
  const { describeError } = useApp();
  const [view, setView] = useState<ProductionWorkflowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const context = `${project}\0${shot}\0${packageDir ?? ''}`;
  const contextRef = useRef(context);
  contextRef.current = context;
  const revision = useRef(0);
  const mutating = useRef(false);
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
    const read = async (): Promise<void> => {
      const version = revision.current;
      try {
        if (!mutating.current) {
          const next = await window.api.productionWorkflow.view(project, shot, packageDir);
          if (active && contextRef.current === context && version === revision.current && !mutating.current) {
            setView(next);
            setError(null);
          }
        }
      } catch (reason) {
        if (active && contextRef.current === context) setError(describeError(reason));
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
  }, [context, project, shot, packageDir, describeError, invalidate]);

  const execute = useCallback(
    async (operation: () => Promise<ProductionWorkflowView>, applied = false): Promise<boolean> => {
      if (mutating.current) return false;
      mutating.current = true;
      const version = ++revision.current;
      setPending(true);
      setError(null);
      try {
        const next = await operation();
        // Ответ старого проекта или пакета не должен менять уже выбранный пользователем контекст.
        if (contextRef.current !== context || version !== revision.current) return false;
        setView(next);
        if (applied) await onApplied(next.packageDir);
        return true;
      } catch (reason) {
        if (contextRef.current === context && version === revision.current) setError(describeError(reason));
        return false;
      } finally {
        if (contextRef.current === context && version === revision.current) {
          mutating.current = false;
          setPending(false);
        }
      }
    },
    [context, describeError, onApplied]
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
      view?.proposal ? execute(() => window.api.productionWorkflow.apply(project, shot, packageDir, view.proposal!.id), true) : Promise.resolve(false),
    discard: () =>
      view?.proposal ? execute(() => window.api.productionWorkflow.discard(project, shot, packageDir, view.proposal!.id)) : Promise.resolve(false),
    cancel: async (id: string): Promise<void> => {
      await execute(async () => {
        await window.api.agents.cancel(id);
        return window.api.productionWorkflow.view(project, shot, packageDir);
      });
    }
  };
}
