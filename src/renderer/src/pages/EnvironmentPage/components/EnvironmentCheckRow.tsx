import { environmentTexts } from '@shared/texts/environment';
import type { ReactElement } from 'react';
import { SlottedText } from '../../../components/SlottedText';
import { Box, Button, Chip, CircularProgress, Link, ListItem, ListItemIcon, ListItemText, Stack, Typography } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import ScheduleIcon from '@mui/icons-material/Schedule';
import LoginIcon from '@mui/icons-material/Login';
import RefreshIcon from '@mui/icons-material/Refresh';
import CloseIcon from '@mui/icons-material/Close';
import type { EnvironmentCheck } from '@shared/types';
import { OFFLINE_MESSAGE } from '../../../network';
import { ActionButton } from '../../../components/ActionButton';

export type EnvironmentCheckCategory = 'core' | 'model' | 'external';
export type ProviderAuthStatus = 'checking' | 'authenticated' | 'unauthenticated' | 'unknown';

/** Вход в платного провайдера из строки его программы. */
export interface ProviderLogin {
  status: ProviderAuthStatus;
  message?: string;
  loggingIn: boolean;
  /** Без сети вход в провайдера недоступен. */
  offline: boolean;
  onLogin(): Promise<void>;
  onCheck?(): Promise<void>;
  /** Адрес страницы входа текущего ожидания: приложение открыло его в браузере, ссылка нужна, если браузер не открылся. */
  authorizeUrl?: string;
  onCancel?(): void;
}

interface EnvironmentCheckRowProps {
  check: EnvironmentCheck;
  category: EnvironmentCheckCategory;
  /** Вход по id провайдера; строка показывает его, если она отмечена loginProvider. */
  logins?: Record<string, ProviderLogin>;
}

/** Отсутствие отдельной модели или внешнего CLI показывается нейтрально: они нужны по необходимости. */
export function EnvironmentCheckRow({ check, category, logins }: EnvironmentCheckRowProps): ReactElement {
  const login = check.loginProvider ? logins?.[check.loginProvider] : undefined;
  const pending = check.status === 'pending';
  const running = check.status === 'running';
  const completed = !pending && !running;
  // Причина недоступности кнопки входа по тем же ветвям, что и её условие disabled.
  const loginReason = !login
    ? null
    : login.offline
      ? OFFLINE_MESSAGE
      : !completed
        ? environmentTexts.waitForEnvironment
        : !check.ok
          ? environmentTexts.fixCheckProblem
          : login.status === 'checking'
            ? environmentTexts.waitForAuth
            : environmentTexts.repeatEnvironment;
  return (
    // id строки совпадает с id провайдера из реестра: ссылка «на странице «Среда»» прокручивает к ней.
    <ListItem divider alignItems="flex-start" data-anchor={check.id}>
      <ListItemIcon sx={{ minWidth: 36, mt: 0.5 }}>
        {pending ? (
          <ScheduleIcon color="disabled" />
        ) : running ? (
          <CircularProgress size={20} aria-label={environmentTexts.checking(check.label)} />
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
      {/* Действия входа содержат блочный Stack: стандартный абзац secondary не может быть их родителем. */}
      <ListItemText
        slotProps={{ secondary: { component: 'div' } }}
        primary={
          <Box sx={{ display: 'flex', gap: 1, alignItems: 'center' }}>
            <Typography fontWeight={600}>{check.label}</Typography>
            {check.bundled || check.productionOnly ? (
              <Chip
                size="small"
                variant="outlined"
                label={
                  check.bundled
                    ? environmentTexts.bundled
                    : category === 'external'
                      ? environmentTexts.external
                      : category === 'model'
                        ? environmentTexts.chosenDuringTiming
                        : environmentTexts.development
                }
              />
            ) : null}
          </Box>
        }
        secondary={
          <>
            <Typography variant="body2" component="span" display="block">
              {pending ? environmentTexts.pending : running ? environmentTexts.running : check.detail}
              {completed && check.elapsedMs !== undefined && (
                <Typography variant="caption" component="span" color="text.secondary" sx={{ ml: 1, whiteSpace: 'nowrap' }}>
                  {environmentTexts.checkElapsed((check.elapsedMs / 1000).toLocaleString('ru-RU', { minimumFractionDigits: 1, maximumFractionDigits: 1 }))}
                </Typography>
              )}
            </Typography>
            {completed && !check.ok ? (
              <Typography variant="caption" component="span" color="text.secondary">
                {check.hint}
              </Typography>
            ) : null}
            {login && (
              <>
                {completed && check.ok && login.status !== 'checking' && (
                  <Typography variant="caption" component="span" display="block" color={login.status === 'unknown' ? 'error' : 'text.secondary'}>
                    {login.status === 'unknown'
                      ? login.message || environmentTexts.authUnknown
                      : login.status === 'authenticated'
                        ? environmentTexts.authenticated
                        : environmentTexts.unauthenticated}
                  </Typography>
                )}
                {login.loggingIn && (
                  <Typography variant="caption" component="span" display="block" color="text.secondary" sx={{ mt: 0.5 }}>
                    {environmentTexts.loginWaiting}
                    {login.authorizeUrl ? (
                      <SlottedText
                        text={environmentTexts.browserNotOpened}
                        slots={{
                          link: (
                            <Link href={login.authorizeUrl} target="_blank" rel="noreferrer">
                              {environmentTexts.openLogin}
                            </Link>
                          )
                        }}
                      />
                    ) : null}
                  </Typography>
                )}
                <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ mt: 1 }}>
                  <ActionButton
                    size="small"
                    variant="outlined"
                    startIcon={login.status === 'unknown' || login.status === 'checking' ? <RefreshIcon /> : <LoginIcon />}
                    onClick={login.status === 'unknown' ? login.onCheck : login.onLogin}
                    loading={login.loggingIn}
                    disabled={login.offline || !completed || !check.ok || login.status === 'checking' || (login.status === 'unknown' && !login.onCheck)}
                    disabledReason={loginReason}
                  >
                    {login.status === 'checking'
                      ? environmentTexts.checkingLogin
                      : login.status === 'authenticated'
                        ? environmentTexts.changeAccount
                        : login.status === 'unauthenticated'
                          ? environmentTexts.login
                          : environmentTexts.checkLogin}
                  </ActionButton>
                  {login.loggingIn && login.onCancel ? (
                    <Button size="small" startIcon={<CloseIcon />} onClick={login.onCancel}>
                      {environmentTexts.cancelLogin}
                    </Button>
                  ) : null}
                </Stack>
              </>
            )}
          </>
        }
      />
    </ListItem>
  );
}
