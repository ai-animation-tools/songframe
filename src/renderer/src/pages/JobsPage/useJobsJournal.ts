/** Локальные инструменты обновляются опросом, агенты — штатным потоком событий. */
import { useEffect, useState } from 'react';
import type { JobInfo } from '@shared/types';
import { useAgentJobs } from '../../hooks/useAgentJobs';
import { useApp } from '../../state';

export function useJobsJournal() {
  const { describeError } = useApp();
  const agents = useAgentJobs();
  const [tools, setTools] = useState<JobInfo[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const load = async (): Promise<void> => {
      try {
        const jobs = await window.api.jobs.list();
        if (!active) return;
        setTools(jobs);
        setError(null);
      } catch (reason) {
        if (active) setError(describeError(reason));
      } finally {
        if (active) {
          setLoading(false);
          // Опрос продолжается и без активных заданий: новые могут прийти из CLI или другой страницы.
          timer = setTimeout(() => void load(), 1500);
        }
      }
    };
    void load();
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [describeError]);

  return { tools, agents: agents.jobs, error: error ?? agents.error, loading, cancel: agents.cancel };
}
