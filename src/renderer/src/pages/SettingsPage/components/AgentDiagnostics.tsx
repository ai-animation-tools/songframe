/** Разделяем запуск CLI и вход: найденный исполняемый файл сам по себе не доказывает авторизацию. */
import type { ReactElement } from 'react';
import { Alert, Paper, Stack, Typography } from '@mui/material';
import type { AgentCheckResult } from '@shared/agents';

export function AgentDiagnostics({ result }: { result: AgentCheckResult }): ReactElement {
  const authorization = { authenticated: 'Вход выполнен', unauthenticated: 'Вход не выполнен', unknown: 'Не удалось определить' }[result.authorization];
  const available = result.availability === 'available';
  return (
    <Paper variant="outlined" sx={{ p: 2 }}>
      <Stack spacing={1} role="status">
        <Typography fontWeight={600}>Результат проверки</Typography>
        <Typography variant="body2">Агент: {available ? 'Доступен' : result.availability === 'not_found' ? 'Не найден' : 'Не запускается'}</Typography>
        {result.executablePath && (
          <Typography variant="body2" sx={{ overflowWrap: 'anywhere' }}>
            Файл: {result.executablePath}
          </Typography>
        )}
        <Typography variant="body2">Версия: {result.version ?? 'Не определена'}</Typography>
        <Typography variant="body2">Авторизация: {authorization}</Typography>
        <Alert severity={available && result.authorization === 'authenticated' ? 'success' : 'warning'}>{result.message}</Alert>
      </Stack>
    </Paper>
  );
}
