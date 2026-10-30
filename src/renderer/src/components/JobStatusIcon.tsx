/** Значок состояния задания используется рядом с его названием. */
import { commonTexts } from '@shared/texts/common';
import type { ReactElement } from 'react';
import { CircularProgress } from '@mui/material';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import ErrorIcon from '@mui/icons-material/Error';
import WarningIcon from '@mui/icons-material/Warning';
import type { JobInfo } from '@shared/types';

export function JobStatusIcon({ job }: { job: JobInfo }): ReactElement {
  if (job.status === 'running') return <CircularProgress size={16} />;
  if (job.status === 'done') return <CheckCircleIcon color="success" fontSize="small" />;
  if (job.status === 'interrupted') return <WarningIcon color="warning" fontSize="small" titleAccess={commonTexts.job.interrupted} />;
  return <ErrorIcon color="error" fontSize="small" />;
}
