import type { ReactElement } from 'react';
import { Box, Stack, Typography } from '@mui/material';
import type { JobInfo } from '@shared/types';
import { songTimingTexts as texts } from '@shared/texts/song-timing';
import { JobStatus } from '../../../components/JobStatus';

/** Рабочее окно показывает понятное действие; stdout/JSON остаются закрытой диагностикой.
 * Терминальный итог сообщает владелец операции после проверки и чтения результата. */
export function TimingJobProgress({ job, label, name }: { job: JobInfo; label: string; name: string }): ReactElement {
  return (
    <Stack spacing={1}>
      {job.status === 'running' && (
        <Box role="status" aria-label={name}>
          <JobStatus running label={label} />
        </Box>
      )}
      {job.log && (
        <Box component="details">
          <Typography component="summary" variant="body2" sx={{ cursor: 'pointer' }}>
            {texts.technicalLog}
          </Typography>
          <Typography
            component="pre"
            variant="caption"
            sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 200, overflow: 'auto', m: 0, mt: 1 }}
          >
            {job.log}
          </Typography>
        </Box>
      )}
    </Stack>
  );
}
