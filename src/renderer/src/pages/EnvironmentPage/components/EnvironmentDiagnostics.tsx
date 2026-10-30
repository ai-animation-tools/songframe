import { environmentTexts } from '@shared/texts/environment';
import type { ReactElement } from 'react';
import { Alert, Box, CircularProgress, LinearProgress } from '@mui/material';
import type { EnvironmentCheck } from '@shared/types';
import { EnvironmentCheckGroup } from './EnvironmentCheckGroup';
import type { ProviderLogin } from './EnvironmentCheckRow';

interface EnvironmentDiagnosticsProps {
  checks: EnvironmentCheck[] | null;
  loading: boolean;
  error: string | null;
  /** Вход по id платного провайдера для строк его программы. */
  logins?: Record<string, ProviderLogin>;
}

/** Модель и внешние CLI не влияют на готовность основных ресурсов приложения. */
export function EnvironmentDiagnostics({ checks, loading, error, logins }: EnvironmentDiagnosticsProps): ReactElement {
  if (!checks?.length) {
    if (error) return <Alert severity="error">{environmentTexts.checkFailed(error)}</Alert>;
    if (!loading) return <Alert severity="info">{checks === null ? environmentTexts.notChecked : environmentTexts.noResults}</Alert>;
    return (
      <Box sx={{ display: 'flex', justifyContent: 'center', p: 4 }}>
        <CircularProgress aria-label={environmentTexts.checkingEnvironment} />
      </Box>
    );
  }

  // Внешняя программа из поставки относится к ресурсам приложения; модель показывается отдельно.
  const coreChecks = checks.filter((check) => (check.external ? check.bundled : check.id !== 'whisper-model'));
  const externalChecks = checks.filter((check) => check.external && !check.bundled);
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
      {loading && <LinearProgress aria-label={environmentTexts.checkingEnvironment} />}
      {error && <Alert severity="error">{environmentTexts.checkInterrupted(error)}</Alert>}
      {missingCore.length ? <Alert severity="error">{environmentTexts.missingCore(missingCore.map((check) => check.label).join(', '))}</Alert> : null}
      {missingProduction.length ? (
        <Alert severity="warning">{environmentTexts.missingProduction(missingProduction.map((check) => check.label).join(', '))}</Alert>
      ) : completed && missingCore.length === 0 ? (
        <Alert severity="success">{environmentTexts.resourcesAvailable}</Alert>
      ) : null}
      <EnvironmentCheckGroup title={environmentTexts.coreGroup} items={coreChecks} category="core" logins={logins} />
      <EnvironmentCheckGroup title={environmentTexts.modelGroup} items={checks.filter((check) => check.id === 'whisper-model')} category="model" />
      <EnvironmentCheckGroup title={environmentTexts.externalGroup} items={externalChecks} category="external" logins={logins} />
    </Box>
  );
}
