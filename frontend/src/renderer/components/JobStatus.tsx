/**
 * Состояние задания у его действия: идущее — заметная плашка с названием, бегущей полосой и прошедшим временем,
 * чтобы было видно, что работа идёт, а не стоит; итог — успех или сбой с переходом к полному журналу.
 */
import { commonTexts } from '@shared/texts/common';
import { useEffect, useState, type ReactElement } from 'react';
import { Alert, AlertTitle, Button, LinearProgress, Stack, Typography } from '@mui/material';
import ListAltIcon from '@mui/icons-material/ListAlt';
import { Link } from 'react-router-dom';
import type { JobInfo } from '@shared/types';

/** Адрес журнала задания: страница «Задания» выбирает и прокручивает к нему запись. */
export function jobLogRoute(id?: string | null): string {
  return id ? `/jobs?job=${encodeURIComponent(id)}` : '/jobs';
}

export function JobStatus({ running = false, label, job, error }: { running?: boolean; label?: string; job?: JobInfo; error?: string }): ReactElement | null {
  if (error || job?.status === 'failed' || job?.status === 'interrupted') {
    return (
      <Alert severity="error" sx={{ mt: 1, minWidth: 0, overflowWrap: 'anywhere' }}>
        <AlertTitle>{job?.title ?? commonTexts.job.failed}</AlertTitle>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap' }}>
          {error ?? job?.error ?? commonTexts.job.failedWithCode({ code: job?.code })}
        </Typography>
        <Button component={Link} to={jobLogRoute(job?.id)} color="inherit" size="small" startIcon={<ListAltIcon />} sx={{ mt: 1 }}>
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
  if (!running)
    return (
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
    );
  return <RunningJob label={label ?? commonTexts.job.running} startedAt={job?.status === 'running' ? job.startedAt : undefined} />;
}

/** Секунды с момента startedAt (ISO 8601) или, без него, с показа плашки; обновляются раз в секунду. */
function useElapsed(startedAt?: string): number {
  const [shownAt] = useState(() => Date.now());
  const parsed = startedAt ? Date.parse(startedAt) : NaN;
  const from = Number.isFinite(parsed) ? Math.min(parsed, Date.now()) : shownAt;
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(timer);
  }, []);
  return Math.max(0, Math.floor((now - from) / 1000));
}

/** Идущее задание: название, прошедшее время и бегущая полоса; role=status сообщает о нём экранному диктору. */
function RunningJob({ label, startedAt }: { label: string; startedAt?: string }): ReactElement {
  const elapsed = useElapsed(startedAt);
  return (
    <Alert severity="info" icon={false} role="status" sx={{ minWidth: 220, py: 0.5, '& .MuiAlert-message': { width: '100%', py: 0.5 } }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'baseline', flexWrap: 'wrap', minWidth: 0 }}>
        <Typography variant="body2" fontWeight={600} sx={{ overflowWrap: 'anywhere' }}>
          {label}
        </Typography>
        <Typography variant="body2" color="text.secondary">
          {commonTexts.job.elapsed(elapsed)}
        </Typography>
      </Stack>
      <LinearProgress aria-hidden sx={{ mt: 0.75 }} />
    </Alert>
  );
}
