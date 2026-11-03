/**
 * Общий отказ «Ещё не перенесено в Go» на время миграции (D-028). Страница, чей основной метод
 * чтения адаптер platform/api отмечает недоступным, показывает эту причину вместо бесконечной
 * загрузки или сырой ошибки транспорта. Сам компонент не вызывает window.api и ничего не пишет.
 */
import type { ReactElement, ReactNode } from 'react';
import { Alert, AlertTitle, Paper, Stack, Typography } from '@mui/material';
import { migrationTexts } from '@shared/texts/migration';
import { useUnavailableMethod, type ApiMethod } from '../availability';

interface NoticeProps {
  /** Заголовок страницы: раздел остаётся узнаваемым в навигации. */
  title: string;
  /** Причина от адаптера (platformTexts.unavailable). */
  reason: string;
  /** Технический метод для диагностики; показывается мелким текстом. */
  method?: string;
  /** page — вместо целой страницы; section — вместо блока страницы, остальная часть которой работает. */
  level?: 'page' | 'section';
}

export function NotMigratedNotice({ title, reason, method, level = 'page' }: NoticeProps): ReactElement {
  const alert = (
    <Alert severity="info">
      <AlertTitle>{migrationTexts.notMigratedTitle}</AlertTitle>
      {reason}
      <Typography variant="body2" sx={{ mt: 1 }}>
        {migrationTexts.notMigratedHint}
      </Typography>
      {method && (
        <Typography variant="caption" component="p" color="text.secondary" sx={{ mt: 1 }}>
          {migrationTexts.method(method)}
        </Typography>
      )}
    </Alert>
  );
  if (level === 'section')
    return (
      <Paper variant="outlined" sx={{ p: 2 }}>
        <Stack spacing={1.5}>
          <Typography fontWeight={600}>{title}</Typography>
          {alert}
        </Stack>
      </Paper>
    );
  return (
    <Stack spacing={2} sx={{ width: '100%', minWidth: 0 }}>
      <Typography variant="h5" component="h1">
        {title}
      </Typography>
      {alert}
    </Stack>
  );
}

/** Монтирует страницу только при перенесённых методах чтения; иначе показывает общий отказ. */
export function RequireMigrated({
  title,
  methods,
  level,
  children
}: {
  title: string;
  methods: readonly ApiMethod[];
  level?: NoticeProps['level'];
  children: ReactNode;
}): ReactElement {
  const missing = useUnavailableMethod(methods);
  if (missing) return <NotMigratedNotice title={title} reason={missing.reason} method={missing.method} level={level} />;
  return <>{children}</>;
}
