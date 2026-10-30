/** Поток предложения и остановка агента; повтор после прерывания требует нового явного запроса. */
import { commonTexts } from '@shared/texts/common';
import { componentsTexts } from '@shared/texts/components';
import { useState, type ReactElement } from 'react';
import { Alert, Box, Chip, LinearProgress, Stack, Typography } from '@mui/material';
import type { AgentJob } from '@shared/agents';
import { agentTitle } from '@shared/agent-providers';
import { ActionButton } from './ActionButton';
import { AgentButton } from './AgentButton';
import StopIcon from '@mui/icons-material/Stop';
import type { AiActionKind } from '@shared/ai-access';
import { AgentIcon } from './AgentIcon';
import { DateTime } from './DateTime';

const LABELS = componentsTexts.agentJob.statuses;

export function AgentJobCard({
  job,
  onCancel,
  onRetry,
  retryProvider,
  retryKind = 'agent',
  compact = false
}: {
  job: AgentJob;
  onCancel(id: string): Promise<void>;
  onRetry(job: AgentJob): void;
  retryProvider?: AgentJob['provider'];
  retryKind?: AiActionKind;
  /** Рабочие панели сохраняют остановку и повтор, а подробности показывают в общем журнале. */
  compact?: boolean;
}): ReactElement {
  const [cancelling, setCancelling] = useState(false);
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', flexWrap: 'wrap' }}>
        <Typography variant="body2" fontWeight={600} sx={{ overflowWrap: 'anywhere', minWidth: 0 }}>
          {job.task}
        </Typography>
        <Chip size="small" label={LABELS[job.status]} color={job.status === 'completed' ? 'success' : job.status === 'failed' ? 'error' : 'default'} />
        <Typography variant="caption" color="text.secondary">
          <AgentIcon provider={job.provider} size={16} /> {agentTitle(job.provider)} · <DateTime value={job.startedAt} />
        </Typography>
        <Box sx={{ flex: 1 }} />
        {['failed', 'cancelled', 'interrupted'].includes(job.status) && (
          <AgentButton aiKind={retryKind} provider={retryProvider} size="small" onClick={() => onRetry(job)}>
            {commonTexts.retry}
          </AgentButton>
        )}
        {job.status === 'running' && (
          <ActionButton
            startIcon={<StopIcon />}
            size="small"
            color="warning"
            disabled={cancelling}
            disabledReason={componentsTexts.agentJob.cancelling}
            onClick={async () => {
              setCancelling(true);
              try {
                await onCancel(job.id);
              } finally {
                setCancelling(false);
              }
            }}
          >
            {commonTexts.stop}
          </ActionButton>
        )}
      </Stack>
      {job.status === 'running' && (
        <>
          <LinearProgress />
          <Typography variant="caption">{job.phase}</Typography>
        </>
      )}
      {!compact && job.message && <Alert severity={job.status === 'failed' ? 'error' : job.status === 'cancelled' ? 'info' : 'warning'}>{job.message}</Alert>}
      {!compact && job.result && (
        <Typography
          component="pre"
          variant="body2"
          sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', m: 0, p: 1, bgcolor: 'action.hover', borderRadius: 1, maxHeight: 320, overflowY: 'auto' }}
        >
          {job.result}
        </Typography>
      )}
      {!compact && job.log && (
        <Box component="details">
          <Typography component="summary" variant="caption" sx={{ cursor: 'pointer' }}>
            {commonTexts.log}
          </Typography>
          <Typography component="pre" variant="caption" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 160, overflow: 'auto' }}>
            {job.log}
          </Typography>
        </Box>
      )}
    </Stack>
  );
}
