/** Состояние приложения в рендерере: комплекс, текущий проект и его статус, уведомления. */

import { type ReactElement, createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { Alert, Snackbar } from '@mui/material';
import { LinkedText } from './components/LinkedText';
import { CRASH_NOTICE } from './diagnostics';
import type { AppState, JobInfo, ProjectStatus } from '@shared/types';
import type { AgentJob, AgentSettings } from '@shared/agents';
import type { AiAccess } from '@shared/ai-access';
import { offlineAccess, useOnline } from './network';
import { agentFinishedNotice, agentOwnerShowsResult, finishedNotice, ownerShowsResult, routeOf } from './hooks/backgroundJobs';

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
  /** Перечитывает только статус текущего проекта: он вычисляется из файлов, которые меняют страницы, задания и внешние программы. */
  refreshStatus(): Promise<void>;
  openProject(path: string): Promise<ProjectStatus>;
  closeProject(): Promise<void>;
  /** persist: сообщение не закрывается само и по клику мимо, только крестиком. */
  notify(message: string, severity?: Severity, options?: { persist?: boolean }): void;
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
  const currentPath = useRef<string | null>(null);
  const [toast, setToast] = useState<{ message: string; severity: Severity; persist?: boolean } | null>(null);

  const notify = useCallback(
    (message: string, severity: Severity = 'info', options: { persist?: boolean } = {}) => setToast({ message, severity, persist: options.persist }),
    []
  );
  const online = useOnline();

  // Главный процесс отдаёт сведения об аварийном прошлом сеансе один раз за запуск.
  useEffect(() => {
    window.api.diagnostics
      .crashNotice()
      .then((notice) => {
        if (notice?.crashed) notify(CRASH_NOTICE, 'warning', { persist: true });
      })
      .catch(() => undefined);
  }, [notify]);

  const refreshStatus = useCallback(async () => {
    const path = currentPath.current;
    if (!path) return;
    try {
      const next = await window.api.projects.status(path);
      // Ответ по прежнему проекту не подменяет статус после переключения.
      if (currentPath.current === path) setStatus(next);
    } catch {
      // Статус шапки вторичен: ошибку чтения покажет страница, которая работает с этими файлами.
    }
  }, []);

  // Пользователь мог поменять файлы проекта вне приложения: при возврате в окно статус пересчитывается.
  useEffect(() => {
    const onFocus = (): void => void refreshStatus();
    window.addEventListener('focus', onFocus);
    return () => window.removeEventListener('focus', onFocus);
  }, [refreshStatus]);

  // Задания идут в главном процессе и переживают уход со страницы: об итоге сообщаем и там, где пользователь сейчас.
  useEffect(() => {
    let known = new Map<string, string>();
    let first = true;
    const handle = setInterval(async () => {
      let jobs: JobInfo[];
      let agentJobs: AgentJob[];
      try {
        [jobs, agentJobs] = await Promise.all([window.api.jobs.list(), window.api.agents.list()]);
      } catch {
        return;
      }
      const route = routeOf(window.location.hash);
      // Завершённое задание могло изменить файлы проекта: статус в шапке пересчитывается сразу, а не при следующем общем обновлении.
      if (!first && [...jobs, ...agentJobs].some((job) => known.get(job.id) === 'running' && job.status !== 'running')) void refreshStatus();
      if (!first) {
        for (const job of jobs) {
          if (known.get(job.id) !== 'running' || job.status === 'running' || ownerShowsResult(job, route)) continue;
          const notice = finishedNotice(job);
          notify(notice.message, notice.severity);
        }
        for (const job of agentJobs) {
          if (known.get(job.id) !== 'running' || job.status === 'running' || agentOwnerShowsResult(job, route)) continue;
          const notice = agentFinishedNotice(job);
          notify(notice.message, notice.severity);
        }
      }
      first = false;
      known = new Map([...jobs, ...agentJobs].map((job) => [job.id, job.status]));
    }, 3000);
    return () => clearInterval(handle);
  }, [notify, refreshStatus]);

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
    currentPath.current = next.current;
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
      refreshStatus,
      openProject,
      closeProject,
      notify,
      describeError
    }),
    [state, status, loading, aiAccess, online, agentProvider, setAgentProvider, invalidateAiAccess, refresh, refreshStatus, openProject, closeProject, notify]
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
        autoHideDuration={toast?.persist ? null : toast?.severity === 'error' ? 8000 : 3500}
        onClose={(_, reason) => {
          // Ошибку нельзя потерять случайным кликом по странице: она закрывается крестиком или по таймеру.
          if (reason === 'clickaway' && (toast?.severity === 'error' || toast?.persist)) return;
          setToast(null);
        }}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'center' }}
      >
        <Alert severity={toast?.severity ?? 'info'} variant="filled" onClose={() => setToast(null)} sx={{ maxWidth: 640 }}>
          {/* Отсылки «на странице «…»» в уведомлении ведут к цели. */}
          <LinkedText text={toast?.message ?? ''} />
        </Alert>
      </Snackbar>
    </AppContext.Provider>
  );
}

export function useApp(): AppContextValue {
  const value = useContext(AppContext);
  // eslint-disable-next-line no-restricted-syntax -- Ошибка программного контракта hook; пользовательским сообщением интерфейса не является.
  if (!value) throw new Error('useApp вне AppProvider');
  return value;
}
