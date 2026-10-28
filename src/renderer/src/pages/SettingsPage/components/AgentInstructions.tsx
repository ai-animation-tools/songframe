/** Официальные инструкции ведут во внешний браузер; вход выполняется пользователем в терминале. */
import type { ReactElement } from 'react';
import { Link, Stack, Typography } from '@mui/material';
import type { AgentCheckResult } from '@shared/agents';
import { AGENT_PROVIDERS, type AgentProvider } from '@shared/agent-providers';
import { useApp } from '../../../state';

export function AgentInstructions({ provider, result }: { provider: AgentProvider; result: AgentCheckResult }): ReactElement | null {
  const { state } = useApp();
  const info = AGENT_PROVIDERS[provider];
  // Команды CLI одинаковы, но название консоли подсказываем для текущей ОС.
  const terminal = state?.platform === 'win32' ? 'PowerShell или CMD' : 'терминале';
  // Установка и вход нужны только при соответствующей проблеме, а не после успешной проверки.
  if (result.availability === 'available' && result.authorization === 'authenticated') return null;
  const missing = result.availability === 'not_found';
  const needsLogin = result.authorization === 'unauthenticated';
  return (
    <Stack spacing={1}>
      {missing ? (
        <Typography variant="body2">Установите CLI по официальной инструкции или выберите установленный файл выше.</Typography>
      ) : needsLogin ? (
        <Typography variant="body2">
          Выполните вход в {terminal}: <code>{info.loginCommand}</code>.
        </Typography>
      ) : (
        <Typography variant="body2">
          Проверка вручную: <code>{info.statusCommand}</code>.
        </Typography>
      )}
      <Stack direction="row" spacing={2}>
        {missing ? (
          <Link href={info.installUrl} target="_blank" rel="noreferrer">
            Установка
          </Link>
        ) : (
          <Link href={info.loginUrl} target="_blank" rel="noreferrer">
            Вход и проверка
          </Link>
        )}
      </Stack>
    </Stack>
  );
}
