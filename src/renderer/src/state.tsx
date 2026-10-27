/** Состояние приложения в рендерере: комплекс, текущий проект и его статус, уведомления. */

import { type ReactElement, createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { Alert, Snackbar } from '@mui/material';
import type { AppState, ProjectStatus } from '@shared/types';
import type { AgentSettings } from '@shared/agents';

type Severity = 'success' | 'info' | 'warning' | 'error';

interface AppContextValue {
  state: AppState | null;
  status: ProjectStatus | null;
  loading: boolean;
  agentProvider: AgentSettings['provider'] | null;
  setAgentProvider(provider: AgentSettings['provider'] | null): void;
  refresh(): Promise<void>;
  openProject(path: string): Promise<ProjectStatus>;
  closeProject(): Promise<void>;
  notify(message: string, severity?: Severity): void;
  /** Текст ошибки из IPC без служебного префикса Electron. */
  describeError(error: unknown): string;
}

const AppContext = createContext<AppContextValue | null>(null);

export function describeError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

export function AppProvider({ children }: { children: ReactNode }): ReactElement {
  const [state, setState] = useState<AppState | null>(null);
  const [status, setStatus] = useState<ProjectStatus | null>(null);
  const [loading, setLoading] = useState(true);
  const [agentProvider, setAgentProvider] = useState<AgentSettings['provider'] | null>(null);
  const [toast, setToast] = useState<{ message: string; severity: Severity } | null>(null);

  const notify = useCallback((message: string, severity: Severity = 'info') => setToast({ message, severity }), []);

  const refresh = useCallback(async () => {
    const [next, agent] = await Promise.all([window.api.app.state(), window.api.agents.getSettings()]);
    const nextStatus = next.current ? await window.api.projects.status(next.current) : null;
    // Новый проект и его статус показываем вместе, без данных предыдущего клипа.
    setState(next);
    setStatus(nextStatus);
    setAgentProvider(agent?.provider ?? null);
    setLoading(false);
  }, []);

  useEffect(() => {
    refresh().catch((error) => {
      setLoading(false);
      notify(describeError(error), 'error');
    });
  }, [refresh, notify]);

  const openProject = useCallback(
    async (path: string) => {
      const next = await window.api.projects.open(path);
      await refresh();
      return next;
    },
    [refresh]
  );

  const closeProject = useCallback(async () => {
    await window.api.projects.close();
    await refresh();
  }, [refresh]);

  const value = useMemo<AppContextValue>(
    () => ({ state, status, loading, agentProvider, setAgentProvider, refresh, openProject, closeProject, notify, describeError }),
    [state, status, loading, agentProvider, refresh, openProject, closeProject, notify]
  );

  return (
    <AppContext.Provider value={value}>
      {children}
      <Snackbar
        open={!!toast}
        autoHideDuration={toast?.severity === 'error' ? 8000 : 3500}
        onClose={() => setToast(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={toast?.severity ?? 'info'} variant="filled" onClose={() => setToast(null)} sx={{ maxWidth: 640 }}>
          {toast?.message}
        </Alert>
      </Snackbar>
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  if (!value) throw new Error('useApp вне AppProvider');
  return value;
}
