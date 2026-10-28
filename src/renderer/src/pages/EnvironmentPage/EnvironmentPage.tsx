/** Проверка среды: что найдено, чего не хватает и для чего это нужно; восстановление ресурсов разработки. */

import { type ReactElement, useCallback, useEffect, useRef, useState } from 'react';
import { Alert, Stack, Typography } from '@mui/material';
import FactCheckIcon from '@mui/icons-material/FactCheck';
import type { EnvironmentCheck } from '@shared/types';
import { useApp } from '../../state';
import { ApplicationResources, EnvironmentDiagnostics } from './components';
import { ActionButton } from '../../components/ActionButton';
import { PageActionBar } from '../../components/PageActionBar';
import type { ProviderAuthStatus, ProviderLogin } from './components/EnvironmentCheckRow';

export function EnvironmentPage(): ReactElement {
  const { state, refresh, notify, describeError, online } = useApp();
  const [checks, setChecks] = useState<EnvironmentCheck[] | null>(null);
  const [busy, setBusy] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [elapsedMs, setElapsedMs] = useState<number | null>(null);
  // Состояние входа по id платного провайдера: строки и кнопки входа задают проверки среды (loginProvider).
  const [auth, setAuth] = useState<Record<string, { status: ProviderAuthStatus; message?: string }>>({});
  const [loggingIn, setLoggingIn] = useState<Record<string, boolean>>({});
  const authInFlight = useRef(new Map<string, Promise<void>>());
  const loginInFlight = useRef(new Set<string>());
  const mounted = useRef(false);
  const inFlight = useRef<Promise<void> | null>(null);
  const lastChecks = useRef<EnvironmentCheck[] | null>(null);

  const checkAuth = useCallback(
    (provider: string): Promise<void> => {
      if (!mounted.current) return Promise.resolve();
      const current = authInFlight.current.get(provider);
      if (current) return current;
      setAuth((previous) => ({ ...previous, [provider]: { status: 'checking' } }));
      // Проверяем вход через программу провайдера: неизвестный результат не означает выход из аккаунта.
      const pending = Promise.resolve()
        .then(() => window.api.environment.providerAuth(provider))
        .then((result) => {
          if (!mounted.current) return;
          setAuth((previous) => ({ ...previous, [provider]: { status: result.status, message: result.message } }));
        })
        .catch((reason) => {
          if (!mounted.current) return;
          setAuth((previous) => ({ ...previous, [provider]: { status: 'unknown', message: `Не удалось проверить вход: ${describeError(reason)}` } }));
        })
        .finally(() => {
          authInFlight.current.delete(provider);
        });
      authInFlight.current.set(provider, pending);
      return pending;
    },
    [describeError]
  );

  const load = useCallback((): Promise<void> => {
    if (!mounted.current) return Promise.resolve();
    if (inFlight.current) return inFlight.current;
    setBusy(true);
    setError(null);
    setElapsedMs(null);
    // До завершения проверки вход показывается как проверяемый; без запроса входа после неё он неизвестен.
    setAuth({});
    const started = performance.now();
    const progressChecks: EnvironmentCheck[] = [];
    let acceptingProgress = true;
    const authRequested = new Set<string>();
    const checkAuthWhenReady = (check: EnvironmentCheck): void => {
      const provider = check.loginProvider;
      if (!provider || authRequested.has(provider) || !check.ok || (check.status !== 'done' && check.status !== undefined)) return;
      authRequested.add(provider);
      void checkAuth(provider);
    };
    const onProgress = (check: EnvironmentCheck): void => {
      if (!mounted.current || !acceptingProgress) return;
      const index = progressChecks.findIndex((item) => item.id === check.id);
      if (index < 0) progressChecks.push(check);
      else progressChecks[index] = check;
      setChecks([...progressChecks]);
      checkAuthWhenReady(check);
    };
    // Повторный эффект StrictMode использует тот же запрос; старые результаты остаются до первого события новой проверки.
    const pending = Promise.resolve()
      .then(() => window.api.environment.check(onProgress))
      .then((next) => {
        lastChecks.current = next;
        if (!mounted.current) return;
        setChecks(next);
        next.forEach(checkAuthWhenReady);
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
      });
    inFlight.current = pending;
    return pending;
  }, [checkAuth, describeError]);

  useEffect(() => {
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  // Итог повторной проверки виден в уведомлении, даже если строки результатов ниже экрана.
  const recheck = async (): Promise<void> => {
    lastChecks.current = null;
    await load();
    const next = lastChecks.current as EnvironmentCheck[] | null;
    if (!next || !mounted.current) return;
    const missing = next.filter((check) => !check.ok).map((check) => check.label);
    notify(
      missing.length ? `Проверка среды завершена. Не найдено: ${missing.join(', ')}.` : 'Проверка среды завершена: всё доступно.',
      missing.length ? 'warning' : 'success'
    );
  };

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

  // Адрес страницы входа приходит из главного процесса во время ожидания и исчезает с окончанием входа.
  const [authorizeUrls, setAuthorizeUrls] = useState<Record<string, string>>({});
  useEffect(
    () =>
      window.api.environment.onLoginUrl(({ provider, url }) => {
        if (mounted.current) setAuthorizeUrls((previous) => ({ ...previous, [provider]: url }));
      }),
    []
  );

  const login = async (provider: string): Promise<void> => {
    if (loginInFlight.current.has(provider)) return;
    loginInFlight.current.add(provider);
    setLoggingIn((previous) => ({ ...previous, [provider]: true }));
    try {
      // Штатная программа провайдера открывает браузер сама; страница не получает и не сохраняет токены.
      const result = await window.api.environment.loginProvider(provider);
      if (mounted.current) notify(result.message, result.ok ? 'success' : 'error');
    } catch (reason) {
      if (mounted.current) notify(describeError(reason), 'error');
    } finally {
      loginInFlight.current.delete(provider);
      if (mounted.current) {
        setLoggingIn((previous) => ({ ...previous, [provider]: false }));
        setAuthorizeUrls((previous) => Object.fromEntries(Object.entries(previous).filter(([id]) => id !== provider)));
      }
      // После любой попытки входа заново узнаём текущий аккаунт, включая отмену и ошибку браузерного входа.
      await authInFlight.current.get(provider);
      await checkAuth(provider);
    }
  };

  const loginProviders = [...new Set((checks ?? []).flatMap((check) => (check.loginProvider ? [check.loginProvider] : [])))];
  const logins: Record<string, ProviderLogin> = Object.fromEntries(
    loginProviders.map((provider) => [
      provider,
      {
        status: auth[provider]?.status ?? (busy ? 'checking' : 'unknown'),
        message: auth[provider]?.message,
        loggingIn: loggingIn[provider] === true,
        offline: !online,
        onLogin: () => login(provider),
        onCheck: () => checkAuth(provider),
        authorizeUrl: authorizeUrls[provider],
        onCancel: () => void window.api.environment.cancelLogin(provider)
      }
    ])
  );
  const anyLoggingIn = Object.values(loggingIn).some(Boolean);

  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <PageActionBar>
        <Typography variant="h5" sx={{ flex: 1 }}>
          Среда
        </Typography>
        <ActionButton
          variant="contained"
          startIcon={<FactCheckIcon />}
          onClick={() => void recheck()}
          disabled={busy || anyLoggingIn}
          disabledReason={busy ? 'Дождитесь окончания проверки.' : 'Дождитесь окончания входа в провайдера или отмените его.'}
        >
          {busy ? 'Проверка' : 'Проверить'}
        </ActionButton>
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
      <EnvironmentDiagnostics checks={checks} loading={busy} error={error} logins={logins} />
    </Stack>
  );
}
