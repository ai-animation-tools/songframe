import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
/** Просмотр предложения можно закрыть без записи пакета; применение остаётся отдельным действием. */
import { useId, useState, type ReactElement } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress } from '@mui/material';
import type { AgentSettings } from '@shared/agents';
import type { ProductionProposal } from '@shared/production-workflow';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import { PRODUCTION_PASS_LABELS } from '../constants';
import { ProductionProposalPreview, ProposalActions } from './ProductionProposalPreview';

export function ProductionProposalDialog({
  proposal,
  provider,
  videoProvider = null,
  busy,
  error,
  onApply,
  onDiscard
}: {
  proposal: ProductionProposal;
  provider: AgentSettings['provider'] | null;
  videoProvider?: string | null;
  busy: boolean;
  error?: string | null;
  onApply(): Promise<boolean>;
  onDiscard(): Promise<boolean>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const titleId = useId();
  const apply = async (): Promise<void> => {
    if (await onApply()) setOpen(false);
  };
  const discard = async (): Promise<void> => {
    if (await onDiscard()) setOpen(false);
  };
  return (
    <Box data-production-proposal={proposal.id}>
      <Button startIcon={<CompareArrowsIcon />} onClick={() => setOpen(true)}>
        Просмотреть предложение и сравнение
      </Button>
      {/* Окно занимает всё рабочее пространство, как галерея: сравнение двух длинных текстов требует места. */}
      <Dialog
        open={open}
        onClose={() => setOpen(false)}
        aria-labelledby={titleId}
        maxWidth={false}
        fullWidth
        slotProps={{ paper: { sx: { width: 'calc(100% - 32px)', height: 'calc(100% - 32px)', maxHeight: 'calc(100% - 32px)', m: 2 } } }}
      >
        <DialogTitle id={titleId}>Предложение для производства · {PRODUCTION_PASS_LABELS[proposal.stage]}</DialogTitle>
        {busy ? <LinearProgress aria-label="Применяем предложение" /> : null}
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {error ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          ) : null}
          <ProductionProposalPreview
            proposal={proposal}
            provider={provider}
            videoProvider={videoProvider}
            busy={busy}
            onApply={apply}
            onDiscard={discard}
            actions={false}
            fill
          />
        </DialogContent>
        <DialogActions sx={{ gap: 1, flexWrap: 'wrap' }}>
          <Button startIcon={<CancelOutlinedIcon />} onClick={() => setOpen(false)}>
            Закрыть без применения
          </Button>
          <Box sx={{ flex: 1 }} />
          <ProposalActions proposal={proposal} busy={busy} onApply={apply} onDiscard={discard} />
        </DialogActions>
      </Dialog>
    </Box>
  );
}
