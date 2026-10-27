/** Предложение показывается отдельно от сохранённых материалов: завершение задания не означает согласование. */
import type { ReactElement } from 'react';
import { Alert, Box, Paper, Stack, Typography } from '@mui/material';
import type { AgentSettings } from '@shared/agents';
import type { ProductionProposal } from '@shared/production-workflow';
import { AgentIcon } from '../../../components';
import { DestructiveButton } from '../../../components/DestructiveButton';
import CheckIcon from '@mui/icons-material/Check';
import { PRODUCTION_PASS_LABELS, PRODUCTION_PROPOSAL_LABELS } from '../constants';

export function ProductionProposalPreview({
  proposal,
  provider = null,
  busy,
  onApply,
  onDiscard
}: {
  proposal: ProductionProposal;
  provider?: AgentSettings['provider'] | null;
  busy: boolean;
  onApply(): void;
  onDiscard(): void;
}): ReactElement {
  const after = proposal.after;
  const ready = proposal.status === 'ready' && !proposal.stale && !!after;
  const text = after?.stage === 'description' ? after.description : after?.stage === 'prompt' ? after.prompt : after ? JSON.stringify(after, null, 2) : '';
  return (
    <Stack spacing={1}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
        <AgentIcon provider={provider} />
        <Typography fontWeight={600}>Предложение агента · {PRODUCTION_PASS_LABELS[proposal.stage]}</Typography>
      </Stack>
      <Alert severity={proposal.stale || ['failed', 'invalid', 'interrupted'].includes(proposal.status) ? 'warning' : 'info'}>
        {proposal.stale
          ? 'Исходные материалы изменились. Подготовьте новое предложение.'
          : (proposal.message ?? `${PRODUCTION_PROPOSAL_LABELS[proposal.status]}.`)}{' '}
        Применение сохраняет материалы для отдельного согласования; оно не принимает опоры, промпт или платную отправку.
      </Alert>
      {after?.stage === 'frames' ? (
        <Stack direction="row" spacing={2} sx={{ flexWrap: 'wrap' }}>
          {after.images.map((image) => (
            <Box key={image.id} sx={{ width: 240 }}>
              <Box
                component="img"
                src={window.api.shell.fileUrl(image.path)}
                alt={`Кандидат ${image.id}`}
                sx={{ width: '100%', maxHeight: 180, objectFit: 'contain' }}
              />
              <Typography variant="caption">{image.id} · кандидат, не принят</Typography>
              <Typography variant="caption" display="block" sx={{ overflowWrap: 'anywhere' }}>
                {image.path}
              </Typography>
            </Box>
          ))}
        </Stack>
      ) : (
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', md: '1fr 1fr' }, gap: 1 }}>
          <Paper variant="outlined" sx={{ p: 1 }}>
            <Typography variant="subtitle2">До</Typography>
            <Typography component="pre" variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 300, overflow: 'auto' }}>
              {proposal.before || 'Материалов ещё нет.'}
            </Typography>
          </Paper>
          <Paper variant="outlined" sx={{ p: 1 }}>
            <Typography variant="subtitle2">Предложение</Typography>
            <Typography component="pre" variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', maxHeight: 300, overflow: 'auto' }}>
              {text || 'Предложение ещё не получено.'}
            </Typography>
            {after?.stage === 'description' ? (
              <Typography component="pre" variant="caption" sx={{ whiteSpace: 'pre-wrap', maxHeight: 220, overflow: 'auto' }}>
                {JSON.stringify({ requestSeconds: after.requestSeconds, keyframes: after.keyframes }, null, 2)}
              </Typography>
            ) : null}
          </Paper>
        </Box>
      )}
      {proposal.status !== 'applied' && proposal.status !== 'running' ? (
        <Stack direction="row" spacing={1}>
          <DestructiveButton
            label="Применить предложение"
            description="Предложение будет записано в пакет и изменит соответствующие материалы. Принятие и платная отправка требуют отдельного согласования."
            confirmLabel="Применить"
            startIcon={<CheckIcon />}
            variant="contained"
            disabled={busy || !ready}
            onConfirm={onApply}
          />
          <DestructiveButton
            label="Отклонить предложение"
            description="Предложение будет отклонено без применения к пакету."
            confirmLabel="Отклонить"
            disabled={busy}
            onConfirm={onDiscard}
          />
        </Stack>
      ) : null}
    </Stack>
  );
}
