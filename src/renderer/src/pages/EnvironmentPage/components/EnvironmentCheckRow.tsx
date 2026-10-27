import type { ReactElement } from 'react';
import { Box, Button, Chip, CircularProgress, ListItem, ListItemIcon, ListItemText, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ScheduleIcon from '@mui/icons-material/Schedule';
import LoginIcon from '@mui/icons-material/Login';
import RefreshIcon from '@mui/icons-material/Refresh';
import type { EnvironmentCheck } from '@shared/types';

export type EnvironmentCheckCategory = 'core' | 'model' | 'external';
export type KlingAuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'unknown';

interface EnvironmentCheckRowProps {
  check: EnvironmentCheck;
  category: EnvironmentCheckCategory;
  onLoginKling?(): Promise<void>;
  klingLoggingIn?: boolean;
  klingAuthStatus?: KlingAuthStatus;
  klingAuthMessage?: string;
  onCheckKlingAuth?(): Promise<void>;
}

/** Отсутствие отдельной модели или внешнего CLI показывается нейтрально: они нужны по необходимости. */
export function EnvironmentCheckRow({
  check,
  category,
  onLoginKling,
  klingLoggingIn = false,
  klingAuthStatus = 'unknown',
  klingAuthMessage,
  onCheckKlingAuth
}: EnvironmentCheckRowProps): ReactElement {
  const pending = check.status === 'pending';
  const running = check.status === 'running';
  const completed = !pending && !running;
  return (
    <ListItem divider alignItems="flex-start">
      <ListItemIcon sx={{ minWidth: 36, mt: 0.5 }}>
        {pending ? (
          <ScheduleIcon color="disabled" />
        ) : running ? (
          <CircularProgress size={20} aria-label={`${check.label}: выполняется проверка`} />
        ) : check.ok ? (
          <CheckCircleIcon color="success" />
        ) : category !== 'core' ? (
          <Typography component="span" color="text.secondary">
            —
          </Typography>
        ) : check.productionOnly ? (
          <WarningAmberIcon color="warning" />
        ) : (
          <ErrorIcon color="error" />
        )}
      </ListItemIcon>
      <ListItemText
        primary={
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Typography fontWeight={600}>{check.label}</Typography>
            {check.bundled || check.productionOnly ? (
              <Chip
                size="small"
                variant="outlined"
                label={
                  check.bundled
                    ? 'в поставке'
                    : category === 'external'
                      ? 'внешний CLI'
                      : category === 'model'
                        ? 'выбирается при разметке'
                        : 'локальная обработка'
                }
              />
            ) : null}
          </Box>
        }
        secondary={
          <>
            <Typography variant="body2" component="span" display="block">
              {pending ? 'Ожидает проверки' : running ? 'Проверка выполняется' : check.detail}
              {completed && check.elapsedMs !== undefined && (
                <Typography variant="caption" component="span" color="text.secondary" sx={{ ml: 1, whiteSpace: 'nowrap' }}>
                  · {(check.elapsedMs / 1000).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 })} с
                </Typography>
              )}
            </Typography>
            {completed && !check.ok ? (
              <Typography variant="caption" component="span" color="text.secondary">
                {check.hint}
              </Typography>
            ) : null}
            {check.id === 'kling' && onLoginKling && (
              <>
                {completed && check.ok && klingAuthStatus !== 'checking' && (
                  <Typography variant="caption" component="span" display="block" color={klingAuthStatus === 'unknown' ? 'error' : 'text.secondary'}>
                    {klingAuthStatus === 'unknown'
                      ? klingAuthMessage || 'Не удалось определить, выполнен ли вход. Повторите проверку.'
                      : klingAuthStatus === 'authenticated'
                        ? 'Вход в Kling выполнен.'
                        : 'Вход в Kling не выполнен.'}
                  </Typography>
                )}
                <Button
                  size="small"
                  variant="outlined"
                  startIcon={klingAuthStatus === 'unknown' || klingAuthStatus === 'checking' ? <RefreshIcon /> : <LoginIcon />}
                  onClick={klingAuthStatus === 'unknown' ? onCheckKlingAuth : onLoginKling}
                  loading={klingLoggingIn}
                  disabled={!completed || !check.ok || klingAuthStatus === 'checking' || (klingAuthStatus === 'unknown' && !onCheckKlingAuth)}
                  sx={{ mt: 1 }}
                >
                  {klingAuthStatus === 'checking'
                    ? 'Проверка входа'
                    : klingAuthStatus === 'authenticated'
                      ? 'Сменить аккаунт'
                      : klingAuthStatus === 'unauthenticated'
                        ? 'Войти'
                        : 'Проверить вход'}
                </Button>
              </>
            )}
          </>
        }
      />
    </ListItem>
  );
}
