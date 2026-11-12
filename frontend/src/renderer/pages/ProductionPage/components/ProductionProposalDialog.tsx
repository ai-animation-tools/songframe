import { productionTexts } from '@shared/texts/production';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
/** Просмотр предложения можно закрыть без записи пакета; применение остаётся отдельным действием. */
import { useId, useState, type ReactElement } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, TextField } from '@mui/material';
import type { AgentSettings } from '@shared/agents';
import type { ProductionProposal } from '@shared/production-workflow';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import { PRODUCTION_PASS_LABELS } from '../constants';
import { ProductionProposalPreview, ProposalActions } from './ProductionProposalPreview';
import { PromptLimitAlert } from './PromptLimitAlert';
import { promptOverLimit } from '../promptLimit';

export function ProductionProposalDialog({
  proposal,
  provider,
  videoProvider = null,
  busy,
  error,
  promptMaxChars,
  onApply,
  onRevise,
  onDiscard
}: {
  proposal: ProductionProposal;
  provider: AgentSettings['provider'] | null;
  videoProvider?: string | null;
  busy: boolean;
  error?: string | null;
  /** Предел длины видеопромпта провайдера: предложенный промпт длиннее него принять нельзя. */
  promptMaxChars?: number;
  onApply(): Promise<boolean>;
  /** Замечание и запуск доработки агентом: одно действие над этим предложением. */
  onRevise(note: string): Promise<boolean>;
  onDiscard(): Promise<boolean>;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [reviseNote, setReviseNote] = useState<string | null>(null);
  const titleId = useId();
  const after = proposal.after;
  const overLimit = after?.stage === 'prompt' ? promptOverLimit(after.prompt, promptMaxChars) : null;
  const apply = async (): Promise<void> => {
    if (await onApply()) setOpen(false);
  };
  const revise = async (): Promise<void> => {
    if (reviseNote?.trim() && (await onRevise(reviseNote.trim()))) setOpen(false);
  };
  const discard = async (): Promise<void> => {
    if (await onDiscard()) setOpen(false);
  };
  return (
    <Box data-production-proposal={proposal.id}>
      <Button variant="contained" startIcon={<CompareArrowsIcon />} onClick={() => setOpen(true)}>
        {productionTexts.productionProposalDialog.open}
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
        <DialogTitle id={titleId}>{productionTexts.productionProposalDialog.title({ stage: PRODUCTION_PASS_LABELS[proposal.stage] })}</DialogTitle>
        {busy ? <LinearProgress aria-label={productionTexts.productionProposalDialog.applying} /> : null}
        <DialogContent sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {error ? (
            <Alert severity="error" sx={{ mb: 2 }}>
              {error}
            </Alert>
          ) : null}
          {overLimit ? (
            <Box sx={{ mb: 2 }}>
              <PromptLimitAlert over={overLimit} videoProvider={videoProvider} />
            </Box>
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
        {reviseNote !== null ? (
          <Box sx={{ px: 3, pb: 1 }}>
            <TextField
              autoFocus
              fullWidth
              multiline
              minRows={2}
              maxRows={6}
              label={productionTexts.productionWorkflowPanel.note}
              value={reviseNote}
              onChange={(event) => setReviseNote(event.target.value)}
            />
          </Box>
        ) : null}
        <DialogActions sx={{ gap: 1, flexWrap: 'wrap' }}>
          <Button startIcon={<CancelOutlinedIcon />} onClick={() => setOpen(false)}>
            {productionTexts.productionProposalDialog.close}
          </Button>
          <Box sx={{ flex: 1 }} />
          <ProposalActions
            proposal={proposal}
            busy={busy}
            revising={reviseNote !== null}
            reviseNote={reviseNote ?? ''}
            applyBlockedReason={overLimit ? productionTexts.promptLimit.approveReason(overLimit) : null}
            onReviseOpen={() => setReviseNote(overLimit ? productionTexts.promptLimit.reviseNote(overLimit) : '')}
            onRevise={() => void revise()}
            onApply={apply}
            onDiscard={discard}
          />
        </DialogActions>
      </Dialog>
    </Box>
  );
}
