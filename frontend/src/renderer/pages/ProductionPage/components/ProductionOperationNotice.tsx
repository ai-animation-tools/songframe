/**
 * Состояние операции выбранной попытки: приёмка, отправка, получение, сводка.
 * Идущая операция закреплена вверху колонки плана и видна при любой прокрутке;
 * итог остаётся на том же месте, над шапкой плана.
 */
import { commonTexts } from '@shared/texts/common';
import type { ReactElement } from 'react';
import { Alert, LinearProgress, Typography } from '@mui/material';
import type { JobInfo } from '@shared/types';
import { JobStatus } from '../../../components/JobStatus';

export function ProductionOperationNotice({
  operation,
  stickyTop
}: {
  operation: { job?: JobInfo; error?: string; running?: boolean; label?: string };
  /** Отступ закрепления, когда колонка прокручивается вместе со страницей. */
  stickyTop: number;
}): ReactElement | null {
  const finished = !!operation.error || (!!operation.job && operation.job.status !== 'running');
  if (finished) return <JobStatus {...operation} />;
  if (!operation.running && operation.job?.status !== 'running') return null;
  return (
    <Alert
      severity="info"
      icon={false}
      role="status"
      sx={{
        position: 'sticky',
        top: stickyTop,
        zIndex: 2,
        // В двух колонках прокручивается сама колонка: закрепляться надо у её верхнего края.
        '@container workspace (min-width: 1100px)': { top: 0 },
        '& .MuiAlert-message': { width: '100%' }
      }}
    >
      <Typography fontWeight={600} gutterBottom>
        {operation.label ?? operation.job?.title ?? commonTexts.job.running}
      </Typography>
      <LinearProgress aria-hidden />
    </Alert>
  );
}
