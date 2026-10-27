import type { ReactElement } from 'react';
import { List, Paper, Typography } from '@mui/material';
import type { EnvironmentCheck } from '@shared/types';
import { EnvironmentCheckRow, type EnvironmentCheckCategory, type KlingAuthStatus } from './EnvironmentCheckRow';

interface EnvironmentCheckGroupProps {
  title: string;
  items: EnvironmentCheck[];
  category: EnvironmentCheckCategory;
  onLoginKling?(): Promise<void>;
  klingLoggingIn?: boolean;
  klingAuthStatus?: KlingAuthStatus;
  klingAuthMessage?: string;
  onCheckKlingAuth?(): Promise<void>;
}

/** Группа объединяет строки диагностики и объясняет назначение необязательных CLI. */
export function EnvironmentCheckGroup({
  title,
  items,
  category,
  onLoginKling,
  klingLoggingIn,
  klingAuthStatus,
  klingAuthMessage,
  onCheckKlingAuth
}: EnvironmentCheckGroupProps): ReactElement {
  return (
    <Paper variant="outlined">
      <Typography variant="subtitle1" sx={{ px: 2, pt: 1 }}>
        {title}
      </Typography>
      {category === 'external' ? (
        <Typography variant="body2" color="text.secondary" sx={{ px: 2, pt: 1 }}>
          Эти CLI устанавливаются отдельно по необходимости. Git нужен для истории и снимков. Локальная разметка работает без внешних CLI.
        </Typography>
      ) : null}
      <List dense disablePadding>
        {items.map((check) => (
          <EnvironmentCheckRow
            key={check.id}
            check={check}
            category={category}
            onLoginKling={onLoginKling}
            klingLoggingIn={klingLoggingIn}
            klingAuthStatus={klingAuthStatus}
            klingAuthMessage={klingAuthMessage}
            onCheckKlingAuth={onCheckKlingAuth}
          />
        ))}
      </List>
    </Paper>
  );
}
