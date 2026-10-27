import CloseIcon from '@mui/icons-material/Close';
/** Просмотр предложения можно закрыть без записи пакета; применение остаётся отдельным действием. */
import { useState, type ReactElement } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle } from '@mui/material';
import type { AgentSettings } from '@shared/agents';
import type { ProductionProposal } from '@shared/production-workflow';
import { AgentButton } from '../../../components';
import { PRODUCTION_PASS_LABELS } from '../constants';
import { ProductionProposalPreview } from './ProductionProposalPreview';

export function ProductionProposalDialog({
  proposal,
  provider,
  busy,
  error,
  onApply,
  onDiscard
}: {
  proposal: ProductionProposal;
  provider: AgentSettings['provider'] | null;
  busy: boolean;
  error?: string | null;
  onApply(): Promise<boolean>;
  onDiscard(): Promise<boolean>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <Box data-production-proposal={proposal.id}>
      <AgentButton provider={provider} onClick={() => setOpen(true)}>
        Просмотреть предложение и сравнение
      </AgentButton>
      <Dialog open={open} onClose={() => setOpen(false)} maxWidth="lg" fullWidth>
        <DialogTitle>Предложение для производства · {PRODUCTION_PASS_LABELS[proposal.stage]}</DialogTitle>
        <DialogContent>
          {error ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          ) : null}
          <ProductionProposalPreview
            proposal={proposal}
            provider={provider}
            busy={busy}
            onApply={async () => {
              if (await onApply()) setOpen(false);
            }}
            onDiscard={async () => {
              if (await onDiscard()) setOpen(false);
            }}
          />
        </DialogContent>
        <DialogActions>
          <Button startIcon={<CloseIcon />} onClick={() => setOpen(false)}>
            Закрыть без применения
          </Button>
        </DialogActions>
      </Dialog>
    </Box>
  );
}
