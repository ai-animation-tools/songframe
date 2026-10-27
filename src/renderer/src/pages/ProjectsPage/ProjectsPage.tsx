/** Выбор проекта: история открытых папок, открытие любой папки, переход к созданию нового. */

import { type ReactElement, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Alert, Stack } from '@mui/material';
import type { ProjectState } from '@shared/types';
import { useApp } from '../../state';
import { ProjectHistory, ProjectsToolbar } from './components';

export function ProjectsPage(): ReactElement {
  const { state, refresh, openProject, notify, describeError } = useApp();
  const navigate = useNavigate();
  const [states, setStates] = useState<Record<string, ProjectState>>({});
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    const load = async (): Promise<void> => {
      const entries = state?.history.filter((h) => h.exists) ?? [];
      const pairs = await Promise.all(
        entries.map(async (h) => {
          try {
            return [h.path, (await window.api.projects.status(h.path)).state] as const;
          } catch {
            return [h.path, 'invalid'] as const;
          }
        })
      );
      if (!cancelled) setStates(Object.fromEntries(pairs));
    };
    load().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [state?.history]);

  const open = async (path: string): Promise<void> => {
    if (busy) return;
    setBusy(path);
    try {
      await openProject(path);
      navigate('/project');
    } catch (error) {
      notify(describeError(error), 'error');
    } finally {
      setBusy(null);
    }
  };

  const pickFolder = async (): Promise<void> => {
    try {
      const path = await window.api.dialog.pickFolder({ title: 'Папка проекта клипа' });
      if (path) await open(path);
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };

  const forget = async (path: string): Promise<void> => {
    try {
      await window.api.projects.forget(path);
      await refresh();
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };

  const history = state?.history ?? [];

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <ProjectsToolbar busy={!!busy} onPickFolder={pickFolder} onCreateProject={() => navigate('/projects/new')} />
      {state && !state.toolsRoot ? (
        <Alert severity="warning">
          Ресурсы приложения не найдены: создание проектов и инструменты недоступны, просмотр работает. Подробности на странице «Среда».
        </Alert>
      ) : null}
      <ProjectHistory history={history} states={states} currentPath={state?.current} busy={!!busy} onOpen={open} onForget={forget} />
    </Stack>
  );
}
