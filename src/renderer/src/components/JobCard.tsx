/** Карточка задания: состояние, шаги с кодами завершения и журнал инструментов. */

import { type ReactElement, useState } from 'react';
import { Box, Button, Chip, LinearProgress, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import type { JobInfo, JobStepInfo } from '@shared/types';
import { JobStatusIcon } from './JobStatusIcon';
import { DateTime } from './DateTime';

function stepColor(step: JobStepInfo): 'default' | 'success' | 'error' | 'info' {
  if (step.status === 'done') return 'success';
  if (step.status === 'failed') return 'error';
  if (step.status === 'running') return 'info';
  return 'default';
}

export function JobCard({ job, lines = 14, expanded = false }: { job: JobInfo; lines?: number; expanded?: boolean }): ReactElement {
  const [full, setFull] = useState(expanded);
  const text = job.log.trim();
  const shown = full ? text : text.split('\n').slice(-lines).join('\n');
  return (
    <Box>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
        <JobStatusIcon job={job} />
        <Typography variant="body2" fontWeight={600} sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>
          {job.title}
        </Typography>
        <Typography variant="caption" color="text.secondary">
          <DateTime value={job.startedAt} />
        </Typography>
        {job.status !== 'running' ? (
          <Chip
            size="small"
            variant="outlined"
            color={job.status === 'done' ? 'success' : 'error'}
            label={job.status === 'done' ? 'без ошибок' : `код ${job.code}`}
            sx={{ height: 20 }}
          />
        ) : null}
        <Box sx={{ flex: 1 }} />
        {job.steps.length > 1
          ? job.steps.map((step, index) => (
              <Chip
                key={`${step.tool}-${index}`}
                size="small"
                color={stepColor(step)}
                variant={step.status === 'pending' ? 'outlined' : 'filled'}
                label={step.code !== null && step.code !== 0 ? `${step.label}: код ${step.code}` : step.label}
                sx={{ height: 20 }}
              />
            ))
          : null}
      </Box>
      {job.status === 'running' ? <LinearProgress sx={{ my: 0.5 }} /> : null}
      <Typography
        component="pre"
        variant="caption"
        sx={{
          whiteSpace: 'pre-wrap',
          overflowWrap: 'anywhere',
          fontFamily: 'monospace',
          m: 0,
          mt: 0.5,
          maxHeight: full ? 480 : 200,
          overflowY: 'auto',
          bgcolor: 'action.hover',
          p: 1,
          borderRadius: 1
        }}
      >
        {shown || 'Журнал пуст.'}
      </Typography>
      {text.split('\n').length > lines ? (
        <Button size="small" startIcon={full ? <ExpandLessIcon /> : <ExpandMoreIcon />} onClick={() => setFull(!full)}>
          {full ? 'Свернуть журнал' : 'Весь журнал'}
        </Button>
      ) : null}
    </Box>
  );
}
