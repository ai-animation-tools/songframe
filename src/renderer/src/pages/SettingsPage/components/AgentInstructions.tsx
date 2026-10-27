/** Официальные инструкции ведут во внешний браузер; вход выполняется пользователем в терминале. */
import type { ReactElement } from 'react';
import { Link, Stack, Typography } from '@mui/material';
import type { AgentCheckResult, AgentSettings } from '@shared/agents';
import { useApp } from '../../../state';

export function AgentInstructions({ provider, result }: { provider: AgentSettings['provider']; result: AgentCheckResult }): ReactElement | null {
  const { state } = useApp();
  const claude = provider === 'claude';
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
          Выполните вход в {terminal}: <code>{claude ? 'claude auth login' : 'codex login'}</code>.
        </Typography>
      ) : (
        <Typography variant="body2">
          Проверка вручную: <code>{claude ? 'claude auth status' : 'codex login status'}</code>.
        </Typography>
      )}
      <Stack direction="row" spacing={2}>
        {missing ? (
          <Link href={claude ? 'https://code.claude.com/docs/en/setup' : 'https://learn.chatgpt.com/docs/codex/cli'} target="_blank" rel="noreferrer">
            Установка
          </Link>
        ) : (
          <Link
            href={claude ? 'https://code.claude.com/docs/en/cli-reference' : 'https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-login'}
            target="_blank"
            rel="noreferrer"
          >
            Вход и проверка
          </Link>
        )}
      </Stack>
    </Stack>
  );
}
