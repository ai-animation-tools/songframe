/** Подписка на проект либо весь журнал; промпты не восстанавливаются из истории автоматически. */
import { useEffect, useState } from 'react';
import type { AgentEvent, AgentJob } from '@shared/agents';
import { useApp } from '../state';
import { applyAgentEvent, mergeAgentJobs } from './agentEvents';

export function useAgentJobs(project?: string) {
  const [jobs, setJobs] = useState<AgentJob[]>([]);
  const [error, setError] = useState<string | null>(null);
  const { describeError, notify } = useApp();
  useEffect(() => {
    let active = true;
    let loaded = false;
    const pending: AgentEvent[] = [];
    setJobs([]);
    setError(null);
    // Подписываемся до list; события, обогнавшие ответ list, применяются по sequence.
    const unsubscribe = window.api.agents.onEvent((event) => {
      if (!active || (project !== undefined && event.project !== project)) return;
      if (!loaded) pending.push(event);
      else setJobs((value) => applyAgentEvent(value, event));
    });
    window.api.agents.list(project).then(
      (value) => {
        if (!active) return;
        loaded = true;
        setJobs(pending.reduce(applyAgentEvent, value));
      },
      (reason) => {
        if (active) {
          loaded = true;
          setError(describeError(reason));
        }
      }
    );
    return () => {
      active = false;
      unsubscribe();
    };
  }, [project, describeError]);

  const cancel = async (id: string): Promise<void> => {
    try {
      const job = await window.api.agents.cancel(id);
      setJobs((value) => mergeAgentJobs(value, [job]));
    } catch (reason) {
      notify(describeError(reason), 'error');
    }
  };
  return { jobs, error, cancel };
}
