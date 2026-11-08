import { settingsTexts } from '@shared/texts/settings';
/** Разделяем запуск CLI и вход: найденный исполняемый файл сам по себе не доказывает авторизацию. */
import type { ReactElement } from 'react';
import { Alert, Paper, Stack, Typography } from '@mui/material';
import type { AgentCheckResult } from '@shared/agents';

export function AgentDiagnostics({ result }: { result: AgentCheckResult }): ReactElement {
  const authorization = {
    authenticated: settingsTexts.authenticated,
    unauthenticated: settingsTexts.unauthenticated,
    unknown: settingsTexts.authorizationUnknown
  }[result.authorization];
  const available = result.availability === 'available';
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1} role="status">
        <Typography fontWeight={600}>{settingsTexts.diagnosticsTitle}</Typography>
        <Typography variant="body2">
          {settingsTexts.agentStatus(
            available ? settingsTexts.available : result.availability === 'not_found' ? settingsTexts.notFound : settingsTexts.notRunning
          )}
        </Typography>
        {result.executablePath && (
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            {settingsTexts.executable(result.executablePath)}
          </Typography>
        )}
        <Typography variant="body2">{settingsTexts.version(result.version ?? settingsTexts.versionUnknown)}</Typography>
        <Typography variant="body2">{settingsTexts.authorization(authorization)}</Typography>
        <Alert severity={available && result.authorization === 'authenticated' ? 'success' : 'warning'}>{result.message}</Alert>
      </Stack>
    </Paper>
  );
}
