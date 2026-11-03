import { commonTexts } from '@shared/texts/common';
import { useCallback, useEffect, useRef, useState, type ReactElement, type ReactNode } from 'react';
import { useLocation } from 'react-router-dom';
import { Stack, Typography } from '@mui/material';
import type { ScenarioStatus } from '@shared/scenario-status';
import { useApp } from '../state';
import { RequestScope } from '../hooks/requestScope';
import { ScenarioRequired } from './ScenarioRequired';

/** Зависимая страница монтируется только после проверки сценария: её проверки среды и редакторы пока не нужны. */
export function RequireScenario({ title, children }: { title: string; children: ReactNode }): ReactElement {
  const { state } = useApp();
  const { pathname } = useLocation();
  const project = state?.current ?? '';
  const key = `${project}\0${pathname}`;
  const scope = useRef(new RequestScope()).current;
  scope.update(key);
  const [result, setResult] = useState<{ key: string; status: ScenarioStatus | null }>({ key: '', status: null });
  const load = useCallback(async (): Promise<void> => {
    scope.invalidate();
    const current = scope.capture(key);
    setResult({ key, status: null });
    try {
      const status = await window.api.scenario.status(project);
      if (current()) setResult({ key, status });
    } catch {
      if (current()) setResult({ key, status: 'invalid' });
    }
  }, [key, project, scope]);
  useEffect(() => {
    void load();
    return () => {
      scope.invalidate();
    };
  }, [load, scope]);
  if (result.key !== key || result.status === null)
    return (
      <Stack spacing={2}>
        <Typography variant="h5">{title}</Typography>
        <Typography color="text.secondary">{commonTexts.scenario.loading}</Typography>
      </Stack>
    );
  if (result.status !== 'ready') return <ScenarioRequired title={title} status={result.status} onRefresh={() => void load()} />;
  return <>{children}</>;
}
