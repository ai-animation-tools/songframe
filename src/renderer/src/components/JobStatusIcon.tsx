/** Значок состояния задания используется рядом с его названием. */
import type { ReactElement } from 'react';
import { CircularProgress } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import type { JobInfo } from '@shared/types';

export function JobStatusIcon({ job }: { job: JobInfo }): ReactElement {
  if (job.status === 'running') return <CircularProgress size={16} />;
  if (job.status === 'done') return <CheckCircleIcon color="success" fontSize="small" />;
  return <ErrorIcon color="error" fontSize="small" />;
}
