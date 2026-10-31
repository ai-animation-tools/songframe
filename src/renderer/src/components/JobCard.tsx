/** Карточка задания: состояние, шаги с кодами завершения и журнал инструментов. */

import { componentsTexts } from '@shared/texts/components';
import { type ReactElement, useState } from 'react';
import { Box, Button, Chip, LinearProgress, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import ExpandLessIcon from '@mui/icons-material/ExpandLess';
import { JOB_INTERRUPTED_MESSAGE, type JobInfo, type JobStepInfo } from '@shared/types';
import { JobStatusIcon } from './JobStatusIcon';
import { DateTime } from './DateTime';

function statusChip(job: JobInfo): { color: 'success' | 'error' | 'warning'; label: string } {
  if (job.status === 'done') return { color: 'success', label: componentsTexts.job.success };
  if (job.status === 'interrupted') return { color: 'warning', label: componentsTexts.job.interrupted };
  return { color: 'error', label: componentsTexts.job.exitCode({ code: job.code }) };
}

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
        {job.status !== 'running' ? <Chip size="small" variant="outlined" {...statusChip(job)} sx={{ height: 20 }} /> : null}
        {job.previousSession ? <Chip size="small" variant="outlined" label={componentsTexts.job.previousSession} sx={{ height: 20 }} /> : null}
        <Box sx={{ flex: 1 }} />
        {job.steps.length > 1
          ? job.steps.map((step, index) => (
              <Chip
                key={`${step.tool}-${index}`}
                size="small"
                color={stepColor(step)}
                variant={step.status === 'pending' ? 'outlined' : 'filled'}
                label={step.code !== null && step.code !== 0 ? componentsTexts.job.stepExitCode({ label: step.label, code: step.code }) : step.label}
                sx={{ height: 20 }}
              />
            ))
          : null}
      </Box>
      {/* Состояние уже называет значок у заголовка. */}
      {job.status === 'running' ? <LinearProgress sx={{ my: 0.5 }} aria-hidden /> : null}
      {job.status === 'interrupted' ? (
        <Typography variant="body2" color="warning.main" sx={{ mt: 0.5 }}>
          {componentsTexts.job.interruptedExplanation({ message: JOB_INTERRUPTED_MESSAGE })}
        </Typography>
      ) : null}
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
        {shown || componentsTexts.job.emptyLog}
      </Typography>
      {text.split('\n').length > lines ? (
        <Button size="small" startIcon={full ? <ExpandLessIcon /> : <ExpandMoreIcon />} onClick={() => setFull(!full)}>
          {full ? componentsTexts.job.collapseLog : componentsTexts.job.fullLog}
        </Button>
      ) : null}
    </Box>
  );
}
