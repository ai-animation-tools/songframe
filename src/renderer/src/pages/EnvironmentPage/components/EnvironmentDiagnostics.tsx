import type { ReactElement } from 'react';
import { Alert, Box, CircularProgress, LinearProgress } from '@mui/material';
import type { EnvironmentCheck } from '@shared/types';
import { EnvironmentCheckGroup } from './EnvironmentCheckGroup';
import type { KlingAuthStatus } from './EnvironmentCheckRow';

interface EnvironmentDiagnosticsProps {
  checks: EnvironmentCheck[] | null;
  loading: boolean;
  error: string | null;
  onLoginKling?(): Promise<void>;
  klingLoggingIn?: boolean;
  klingAuthStatus?: KlingAuthStatus;
  klingAuthMessage?: string;
  onCheckKlingAuth?(): Promise<void>;
}

const externalIds = ['git', 'node', 'kling'];
const separateIds = [...externalIds, 'whisper-model'];

/** Модель и внешние CLI не влияют на готовность основных ресурсов приложения. */
export function EnvironmentDiagnostics({
  checks,
  loading,
  error,
  onLoginKling,
  klingLoggingIn,
  klingAuthStatus,
  klingAuthMessage,
  onCheckKlingAuth
}: EnvironmentDiagnosticsProps): ReactElement {
  if (!checks?.length) {
    if (error) return <Alert severity="error">Не удалось проверить среду: {error}</Alert>;
    if (!loading) return <Alert severity="info">{checks === null ? 'Проверка среды ещё не выполнена.' : 'Проверка завершилась без результатов.'}</Alert>;
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress aria-label="Проверка среды" />
      </Box>
    );
  }

  const coreChecks = checks.filter((check) => !separateIds.includes(check.id) || (check.bundled && externalIds.includes(check.id)));
  const externalChecks = checks.filter((check) => externalIds.includes(check.id) && !check.bundled);
  const completedCore = coreChecks.filter((check) => check.status === 'done' || check.status === undefined);
  const missingProduction = completedCore.filter((check) => !check.ok && check.productionOnly);
  const missingCore = completedCore.filter((check) => !check.ok && !check.productionOnly);
  const completed = !loading && !error && checks.every((check) => check.status === 'done' || check.status === undefined);

  return (
    // Сводные предупреждения занимают строку, независимые группы делят широкую рабочую область.
    <Box
      sx={{
        display: 'grid',
        gridTemplateColumns: 'minmax(0, 1fr)',
        '@container workspace (min-width: 1600px)': { gridTemplateColumns: 'minmax(0, 1.4fr) repeat(2, minmax(0, 1fr))' },
        gap: 2,
        alignItems: 'start',
        '& > *': { minWidth: 0 },
        '& > .MuiLinearProgress-root': { gridColumn: '1 / -1' },
        '& > .MuiAlert-root': { gridColumn: '1 / -1' }
      }}
    >
      {loading && <LinearProgress aria-label="Проверка среды" />}
      {error && <Alert severity="error">Не удалось завершить проверку: {error}. Показаны последние доступные результаты.</Alert>}
      {missingCore.length ? (
        <Alert severity="error">Без этого приложение работает не полностью: {missingCore.map((check) => check.label).join(', ')}.</Alert>
      ) : null}
      {missingProduction.length ? (
        <Alert severity="warning">
          Просмотр и редактирование работают. Не найдены локальные зависимости: {missingProduction.map((check) => check.label).join(', ')}.
        </Alert>
      ) : completed && missingCore.length === 0 ? (
        <Alert severity="success">Ресурсы и библиотеки приложения доступны.</Alert>
      ) : null}
      <EnvironmentCheckGroup
        title="Ресурсы и библиотеки приложения"
        items={coreChecks}
        category="core"
        onLoginKling={onLoginKling}
        klingLoggingIn={klingLoggingIn}
        klingAuthStatus={klingAuthStatus}
        klingAuthMessage={klingAuthMessage}
        onCheckKlingAuth={onCheckKlingAuth}
      />
      <EnvironmentCheckGroup title="Отдельно устанавливаемая модель" items={checks.filter((check) => check.id === 'whisper-model')} category="model" />
      <EnvironmentCheckGroup
        title="Внешние программы — по необходимости"
        items={externalChecks}
        category="external"
        onLoginKling={onLoginKling}
        klingLoggingIn={klingLoggingIn}
        klingAuthStatus={klingAuthStatus}
        klingAuthMessage={klingAuthMessage}
        onCheckKlingAuth={onCheckKlingAuth}
      />
    </Box>
  );
}
