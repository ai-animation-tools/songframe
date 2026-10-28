/** Проверка среды: что найдено, чего не хватает и для чего это нужно; восстановление ресурсов разработки. */

import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Button, Stack, Typography } from '@mui/material';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { EnvironmentCheck } from '@shared/types';
import { useApp } from '../../state';
import { ApplicationResources, EnvironmentDiagnostics } from './components';
import { PageActionBar } from '../../components/PageActionBar';
import type { KlingAuthStatus } from './components/EnvironmentCheckRow';

export function EnvironmentPage(): ReactElement {
  const { state, refresh, notify, describeError, online } = useApp();
  const [checks, setChecks] = useState<EnvironmentCheck[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  const [klingLoggingIn, setKlingLoggingIn] = useState(false);
  const [klingAuthStatus, setKlingAuthStatus] = useState<KlingAuthStatus>('checking');
  const [klingAuthMessage, setKlingAuthMessage] = useState<string>();
  const klingAuthInFlight = useRef<Promise<void> | null>(null);
  const klingLoginInFlight = useRef(false);
  const mounted = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);

  const checkKlingAuth = useCallback((): Promise<void> => {
    if (!mounted.current) return Promise.resolve();
    if (klingAuthInFlight.current) return klingAuthInFlight.current;
    setKlingAuthStatus('checking');
    setKlingAuthMessage(undefined);
    // Проверяем вход через CLI: неизвестный результат не означает выход из аккаунта.
    const pending = Promise.resolve()
      .then(() => window.api.environment.klingAuth())
      .then((result) => {
        if (!mounted.current) return;
        setKlingAuthStatus(result.status);
        setKlingAuthMessage(result.message);
      })
      .catch((reason) => {
        if (!mounted.current) return;
        setKlingAuthStatus('unknown');
        setKlingAuthMessage(`Не удалось проверить вход: ${describeError(reason)}`);
      })
      .finally(() => {
        klingAuthInFlight.current = null;
      });
    klingAuthInFlight.current = pending;
    return pending;
  }, [describeError]);

  const load = useCallback((): Promise<void> => {
    if (!mounted.current) return Promise.resolve();
    if (inFlight.current) return inFlight.current;
    setBusy(true);
    setError(null);
    setElapsedMs(null);
    setKlingAuthStatus('checking');
    setKlingAuthMessage(undefined);
    const started = performance.now();
    const progressChecks: EnvironmentCheck[] = [];
    let acceptingProgress = true;
    let authRequested = false;
    const checkKlingWhenReady = (check: EnvironmentCheck): void => {
      if (authRequested || check.id !== 'kling' || !check.ok || (check.status !== 'done' && check.status !== undefined)) return;
      authRequested = true;
      void checkKlingAuth();
    };
    const onProgress = (check: EnvironmentCheck): void => {
      if (!mounted.current || !acceptingProgress) return;
      const index = progressChecks.findIndex((item) => item.id === check.id);
      if (index < 0) progressChecks.push(check);
      else progressChecks[index] = check;
      setChecks([...progressChecks]);
      checkKlingWhenReady(check);
    };
    // Повторный эффект StrictMode использует тот же запрос; старые результаты остаются до первого события новой проверки.
    const pending = Promise.resolve()
      .then(() => window.api.environment.check(onProgress))
      .then((next) => {
        if (!mounted.current) return;
        setChecks(next);
        next.forEach(checkKlingWhenReady);
      })
      .catch((reason) => {
        if (!mounted.current) return;
        setError(describeError(reason));
        // При обрыве worker сохраняем готовые результаты, но не оставляем незавершённые строки с бесконечным spinner.
        if (progressChecks.length) setChecks(progressChecks.filter((check) => check.status === 'done' || check.status === undefined));
      })
      .finally(() => {
        acceptingProgress = false;
        inFlight.current = null;
        if (!mounted.current) return;
        setElapsedMs(performance.now() - started);
        setBusy(false);
        if (!authRequested) setKlingAuthStatus('unknown');
      });
    inFlight.current = pending;
    return pending;
  }, [checkKlingAuth, describeError]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const chooseToolsRoot = async (): Promise<void> => {
    const path = await window.api.dialog.pickFolder({ title: 'Папка исходников SongFrame' });
    if (!path) return;
    try {
      // Смена ресурсов начинает следующую проверку после завершения запроса к прежней папке.
      await inFlight.current;
      await window.api.app.setToolsRoot(path);
      await refresh();
      await load();
      notify('Папка исходников сохранена', 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };

  const resetToolsRoot = async (): Promise<void> => {
    await inFlight.current;
    await window.api.app.setToolsRoot(null);
    await refresh();
    await load();
  };

  const loginKling = async (): Promise<void> => {
    if (klingLoginInFlight.current) return;
    klingLoginInFlight.current = true;
    setKlingLoggingIn(true);
    try {
      // Штатный CLI открывает браузер сам; страница не получает и не сохраняет токены.
      const result = await window.api.environment.loginKling();
      if (mounted.current) notify(result.message, result.ok ? 'success' : 'error');
    } catch (reason) {
      if (mounted.current) notify(describeError(reason), 'error');
    } finally {
      klingLoginInFlight.current = false;
      if (mounted.current) setKlingLoggingIn(false);
      // После любой попытки входа заново узнаём текущий аккаунт, включая отмену и ошибку браузерного входа.
      await klingAuthInFlight.current;
      await checkKlingAuth();
    }
  };

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <PageActionBar>
        <Typography variant="h5" sx={{ flex: 1 }}>
          Среда
        </Typography>
        <Button variant="contained" startIcon={<RefreshIcon />} onClick={load} disabled={busy || klingLoggingIn}>
          {busy ? 'Проверка' : 'Проверить'}
        </Button>
      </PageActionBar>
      {state?.problems?.map((problem) => (
        <Alert key={problem} severity="warning">
          {problem}
        </Alert>
      ))}
      <ApplicationResources state={state} onChooseToolsRoot={chooseToolsRoot} onResetToolsRoot={resetToolsRoot} />
      {elapsedMs !== null && (
        <Typography variant="body2" color="text.secondary">
          Время проверки: {(elapsedMs / 1000).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} с
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary">
        Python показывает время запуска интерпретатора, библиотеки — время их импорта.
      </Typography>
      <EnvironmentDiagnostics
        checks={checks}
        loading={busy}
        error={error}
        onLoginKling={loginKling}
        klingLoggingIn={klingLoggingIn}
        klingOffline={!online}
        klingAuthStatus={klingAuthStatus}
        klingAuthMessage={klingAuthMessage}
        onCheckKlingAuth={checkKlingAuth}
      />
    </Stack>
  );
}
