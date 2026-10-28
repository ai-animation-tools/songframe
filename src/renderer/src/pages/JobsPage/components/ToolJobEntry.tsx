/** Запись задания инструментов в журнале: карточка, хвост журнала прошлого сеанса с диска и копирование для разработчика. */
import { useEffect, useState, type ReactElement } from 'react';
import { Box, Button, Stack } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import type { JobInfo } from '@shared/types';
import { JobCard } from '../../../components/JobCard';

export function ToolJobEntry({ job, onCopy }: { job: JobInfo; onCopy: (job: JobInfo) => void }): ReactElement {
  const [saved, setSaved] = useState<JobInfo | null>(null);

  useEffect(() => {
    // В списке у заданий прошлых сеансов нет текста журнала: хвост читается из файла один раз.
    if (!job.previousSession) return;
    let active = true;
    window.api.jobs
      .get(job.id)
      .then((next) => {
        if (active) setSaved(next);
      })
      .catch(() => undefined);
    return () => {
      active = false;
    };
  }, [job.id, job.previousSession]);

  return (
    <Stack spacing={0.5} sx={{ minWidth: 0 }}>
      <JobCard job={saved ?? job} />
      <Box>
        <Button size="small" startIcon={<ContentCopyIcon />} onClick={() => onCopy(job)}>
          Скопировать журнал
        </Button>
      </Box>
    </Stack>
  );
}
