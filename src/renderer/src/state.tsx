/** Состояние приложения в рендерере: комплекс, текущий проект и его статус, уведомления. */

import { type ReactElement, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Snackbar } from '@mui/material';
import type { AppState, ProjectStatus } from '@shared/types';
import type { AgentSettings } from '@shared/agents';
import type { AiAccess } from '@shared/ai-access';
import { offlineAccess, useOnline } from './network';

type Severity = 'success' | 'info' | 'warning' | 'error';

interface AppContextValue {
  state: AppState | null;
  status: ProjectStatus | null;
  loading: boolean;
  /** Без сети содержит причину «Нет подключения к сети» для всех исполнителей. */
  aiAccess: AiAccess | null;
  /** Компьютер подключён к сети; без неё сетевые действия заблокированы. */
  online: boolean;
  refreshAiAccess(): Promise<void>;
  /** Немедленно блокирует AI-действия перед сохранением новых настроек. */
  invalidateAiAccess(): void;
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
  const [agentProvider, updateAgentProvider] = useState<AgentSettings['provider'] | null>(null);
  const [aiAccess, setAiAccess] = useState<AiAccess | null>(null);
  const scope = useRef(0);
  const [toast, setToast] = useState<{ message: string; severity: Severity } | null>(null);

  const notify = useCallback((message: string, severity: Severity = 'info') => setToast({ message, severity }), []);
  const online = useOnline();

  const invalidateAiAccess = useCallback(() => {
    scope.current += 1;
    setAiAccess(null);
  }, []);

  const refresh = useCallback(async () => {
    invalidateAiAccess();
    const current = scope.current;
    const [next, agent] = await Promise.all([window.api.app.state(), window.api.agents.getSettings()]);
    if (current !== scope.current) return;
    const nextStatus = next.current ? await window.api.projects.status(next.current) : null;
    if (current !== scope.current) return;
    // Локальный просмотр появляется до проверки CLI и входа; AI-действия пока остаются заблокированы.
    setState(next);
    setStatus(nextStatus);
    updateAgentProvider(agent?.provider ?? null);
    setLoading(false);
    try {
      const access = await window.api.ai.access(next.current);
      // Ответ старой проверки не может разрешить ИИ после смены проекта или настроек.
      if (current === scope.current) setAiAccess(access);
    } catch (error) {
      // Сбой диагностики блокирует только ИИ, сохраняя просмотр и редактирование проекта.
      if (current === scope.current) notify(describeError(error), 'error');
    }
  }, [invalidateAiAccess, notify]);

  // Проверка читает сохранённые настройки заново, поэтому одинаковый provider с новым путём CLI тоже обновляет доступность.
  const setAgentProvider = useCallback(
    (provider: AgentSettings['provider'] | null) => {
      updateAgentProvider(provider);
      void refresh().catch((error) => notify(describeError(error), 'error'));
    },
    [refresh, notify]
  );

  useEffect(() => {
    refresh().catch((error) => {
      setLoading(false);
      notify(describeError(error), 'error');
    });
  }, [refresh, notify]);

  const openProject = useCallback(
    async (path: string) => {
      invalidateAiAccess();
      const next = await window.api.projects.open(path);
      await refresh();
      return next;
    },
    [refresh, invalidateAiAccess]
  );

  const closeProject = useCallback(async () => {
    invalidateAiAccess();
    await window.api.projects.close();
    await refresh();
  }, [refresh, invalidateAiAccess]);

  const value = useMemo<AppContextValue>(
    () => ({
      state,
      status,
      loading,
      aiAccess: online ? aiAccess : offlineAccess(aiAccess),
      online,
      refreshAiAccess: refresh,
      invalidateAiAccess,
      agentProvider,
      setAgentProvider,
      refresh,
      openProject,
      closeProject,
      notify,
      describeError
    }),
    [state, status, loading, aiAccess, online, agentProvider, setAgentProvider, invalidateAiAccess, refresh, openProject, closeProject, notify]
  );

  // Проверки доступности, сделанные без сети, устарели: после восстановления связи повторяем их.
  const wasOnline = useRef(online);
  useEffect(() => {
    if (online && !wasOnline.current) void refresh().catch(() => {});
    wasOnline.current = online;
  }, [online, refresh]);

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
