import { useCallback, useEffect, useRef, useState } from 'react';
import type { ScenarioPass, ScenarioWorkflowView } from '@shared/scenario-workflow';
import { useApp } from '../../state';

/** Опрос восстанавливает предложение после перезапуска и не затрагивает черновики редакторов. */
export function useScenarioWorkflow(project: string, onApplied: (pass: ScenarioPass) => Promise<void>) {
  const { describeError } = useApp();
  const [view, setView] = useState<ScenarioWorkflowView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [pollError, setPollError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const [pollingRevision, setPollingRevision] = useState(0);
  const generation = useRef(0);
  const applying = useRef(false);

  useEffect(() => {
    setView(null);
    setError(null);
    setPollError(null);
  }, [project]);

  useEffect(() => {
    let active = true;
    let reading = false;
    const revision = ++generation.current;
    const read = async (): Promise<void> => {
      if (reading || applying.current) return;
      reading = true;
      try {
        const next = await window.api.scenarioWorkflow.view(project);
        if (active && generation.current === revision) {
          setView((current) => (JSON.stringify(current) === JSON.stringify(next) ? current : next));
          setPollError(null);
        }
      } catch (reason) {
        if (active && generation.current === revision) setPollError(describeError(reason));
      } finally {
        reading = false;
      }
    };
    void read();
    // Постоянный опрос также ловит завершение, пришедшее раньше подписки или ответа start.
    const timer = setInterval(() => void read(), 700);
    return () => {
      active = false;
      clearInterval(timer);
    };
  }, [project, describeError, pollingRevision]);

  const execute = useCallback(
    async (operation: () => Promise<ScenarioWorkflowView>, pass?: ScenarioPass): Promise<boolean> => {
      if (applying.current) return false;
      applying.current = true;
      const revision = ++generation.current;
      setPending(true);
      setError(null);
      setPollError(null);
      try {
        const next = await operation();
        // Ответ старого проекта не должен появляться после переключения папки клипа.
        if (generation.current !== revision) return false;
        setView(next);
        if (pass) await onApplied(pass);
        return true;
      } catch (reason) {
        setError(describeError(reason));
        return false;
      } finally {
        applying.current = false;
        setPending(false);
        setPollingRevision((value) => value + 1);
      }
    },
    [describeError, onApplied]
  );

  return {
    view,
    error: error ?? pollError,
    pending,
    busy: pending || !!view?.busy,
    refresh: () => execute(() => window.api.scenarioWorkflow.view(project)),
    start: (pass: ScenarioPass, note?: string, selectedIds?: string[]) =>
      execute(() => window.api.scenarioWorkflow.start({ project, pass, note, selectedIds })),
    approve: () => execute(() => window.api.scenarioWorkflow.approveCurrent(project)),
    approveScenes: () => execute(() => window.api.scenarioWorkflow.approveScenes(project)),
    apply: () => {
      const proposal = view?.proposal;
      return proposal ? execute(() => window.api.scenarioWorkflow.apply(project, proposal.id), proposal.pass) : Promise.resolve(false);
    },
    discard: () => {
      const proposal = view?.proposal;
      return proposal ? execute(() => window.api.scenarioWorkflow.discard(project, proposal.id)) : Promise.resolve(false);
    },
    cancel: async (id: string): Promise<void> => {
      await execute(async () => {
        await window.api.agents.cancel(id);
        return window.api.scenarioWorkflow.view(project);
      });
    }
  };
}
