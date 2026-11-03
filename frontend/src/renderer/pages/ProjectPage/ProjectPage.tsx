import { projectTexts } from '@shared/texts/project';
/** Обзор проекта: состояние, признаки, проблемы и следующий шаг. */

import { type ReactElement, useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Box, Stack, Typography } from '@mui/material';
import { useApp } from '../../state';
import { EditBundleCard, NextStepCard, ProjectChecksCard, ProjectHeader, ProjectProblems, ProjectRenameDialog, ProjectSettingsCard } from './components';

export function ProjectPage(): ReactElement {
  const { status, refresh, closeProject, state, notify, describeError } = useApp();
  const [pythonAvailable, setPythonAvailable] = useState<boolean | null>(null);
  const [renaming, setRenaming] = useState(false);
  const [openingFolder, setOpeningFolder] = useState(false);
  const checkEnvironment = useCallback(async () => {
    await window.api.environment
      .check()
      .then((checks) => setPythonAvailable(checks.find((c) => c.id === 'python')?.ok ?? false))
      .catch(() => setPythonAvailable(false));
  }, []);
  useEffect(() => {
    void checkEnvironment();
  }, [checkEnvironment]);
  const act = async (action: () => Promise<unknown>): Promise<void> => {
    try {
      await action();
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };
  const navigate = useNavigate();
  if (!status) return <Typography>{projectTexts.noProject}</Typography>;

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <ProjectHeader
        status={status}
        onRename={() => setRenaming(true)}
        openingFolder={openingFolder}
        onRefresh={() => act(() => Promise.all([refresh(), checkEnvironment()]))}
        onOpenFolder={async () => {
          setOpeningFolder(true);
          try {
            await act(() => window.api.shell.openPath(status.path));
          } finally {
            setOpeningFolder(false);
          }
        }}
        onClose={() => act(() => closeProject().then(() => navigate('/projects')))}
      />
      {renaming && <ProjectRenameDialog key={status.path} project={status.path} name={status.name} onClose={() => setRenaming(false)} />}
      <ProjectProblems status={status} />
      {/* Настройки располагаются справа при достаточной ширине рабочей области. */}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'minmax(0, 1fr)',
          alignItems: 'start',
          gap: 2,
          '@container workspace (min-width: 1600px)': { gridTemplateColumns: 'repeat(2, minmax(0, 1fr))' },
          '& > *': { minWidth: 0 }
        }}
      >
        <Stack spacing={2} sx={{ minWidth: 0 }}>
          <Box
            sx={{
              display: 'grid',
              gridTemplateColumns: 'repeat(auto-fit, minmax(min(100%, 340px), 1fr))',
              gap: 2,
              '& > *': { minWidth: 0 }
            }}
          >
            <NextStepCard status={status} />
            <ProjectChecksCard status={status} />
          </Box>
          {status.checks.scenes && state?.current ? <EditBundleCard project={state.current} pythonAvailable={pythonAvailable ?? false} /> : null}
        </Stack>
        <ProjectSettingsCard key={`settings:${status.path}`} project={status.path} name={status.name} />
      </Box>
    </Stack>
  );
}
