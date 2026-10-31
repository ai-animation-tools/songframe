/** Результат операции остаётся у действия; полный журнал доступен из сообщения о сбое. */
import { commonTexts } from '@shared/texts/common';
import type { ReactElement } from 'react';
import { Alert, AlertTitle, Button, CircularProgress, Stack, Typography } from '@mui/material';
import ListAltIcon from '@mui/icons-material/ListAlt';
import { Link } from 'react-router-dom';
import type { JobInfo } from '@shared/types';

export function JobStatus({ running = false, label, job, error }: { running?: boolean; label?: string; job?: JobInfo; error?: string }): ReactElement | null {
  if (error || job?.status === 'failed' || job?.status === 'interrupted') {
    return (
      <Alert severity="error" sx={{ mt: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
        <AlertTitle>{job?.title ?? commonTexts.job.failed}</AlertTitle>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          {error ?? job?.error ?? commonTexts.job.failedWithCode({ code: job?.code })}
        </Typography>
        <Button component={Link} to="/jobs" color="inherit" size="small" startIcon={<ListAltIcon />} sx={{ mt: 1 }}>
          {commonTexts.job.openLog}
        </Button>
      </Alert>
    );
  }
  if (job?.status === 'done')
    return (
      <Alert severity="success" sx={{ mt: 1 }}>
        {commonTexts.job.done({ title: job.title })}
      </Alert>
    );
  running ||= job?.status === 'running';
  label ??= job?.title;
  if (!running && !label) return null;

  return (
    <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
      {/* Состояние передаёт подпись рядом. */}
      {running && <CircularProgress size={14} aria-hidden />}
      <Typography variant="body2" color="text.secondary">
        {label ?? commonTexts.job.running}
      </Typography>
    </Stack>
  );
}
