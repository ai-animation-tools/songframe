import { productionTexts } from '@shared/texts/production';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
/** Просмотр предложения можно закрыть без записи пакета; применение остаётся отдельным действием. */
import { useId, useState, type ReactElement } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, TextField } from '@mui/material';
import type { AgentSettings } from '@shared/agents';
import type { ProductionProposal } from '@shared/production-workflow';
import type { PromptVariant } from '@shared/types';
import CompareArrowsIcon from '@mui/icons-material/CompareArrows';
import { PRODUCTION_PASS_LABELS } from '../constants';
import { ProductionProposalPreview, ProposalActions } from './ProductionProposalPreview';
import { PromptLimitAlert } from './PromptLimitAlert';
import { promptOverLimit } from '../promptLimit';
import { promptVariantText } from './PromptVariantsText';

export function ProductionProposalDialog({
  proposal,
  provider,
  videoProvider = null,
  busy,
  error,
  promptMaxChars,
  onApply,
  onRevise,
  onDiscard,
  onFixScenario,
  fixRestarts = false
}: {
  proposal: ProductionProposal;
  provider: AgentSettings['provider'] | null;
  videoProvider?: string | null;
  busy: boolean;
  error?: string | null;
  /** Предел длины видеопромпта провайдера: предложенный промпт длиннее него принять нельзя. */
  promptMaxChars?: number;
  /** Принять предложение; у видеопромпта с переводом — с вариантом, выбранным к отправке. */
  onApply(promptVariant?: PromptVariant): Promise<boolean>;
  /** Замечание и запуск доработки агентом: одно действие над этим предложением. */
  onRevise(note: string): Promise<boolean>;
  onDiscard(): Promise<boolean>;
  /** Исправления из отказа агента в сценарий (и, при fixRestarts, новая подготовка описания). */
  onFixScenario?(): Promise<boolean>;
  fixRestarts?: boolean;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const [reviseNote, setReviseNote] = useState<string | null>(null);
  const titleId = useId();
  // К отправке по умолчанию выбран оригинал; выбор перевода есть, только если агент его предложил.
  const [sendVariant, setSendVariant] = useState<PromptVariant>('original');
  const after = proposal.after;
  const variants = after?.stage === 'prompt' && after.translation ? { original: after.prompt, translation: after.translation } : undefined;
  const overLimit = after?.stage === 'prompt' ? promptOverLimit(promptVariantText(after.prompt, variants, sendVariant), promptMaxChars) : null;
  const apply = async (): Promise<void> => {
    if (await onApply(variants ? sendVariant : undefined)) setOpen(false);
  };
  const revise = async (): Promise<void> => {
    if (reviseNote?.trim() && (await onRevise(reviseNote.trim()))) setOpen(false);
  };
  const discard = async (): Promise<void> => {
    if (await onDiscard()) setOpen(false);
  };
  const fixScenario = async (): Promise<void> => {
    if (onFixScenario && (await onFixScenario())) setOpen(false);
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
            busy={busy}
            onApply={apply}
            onDiscard={discard}
            actions={false}
            fill
            sendVariant={sendVariant}
            onSendVariant={setSendVariant}
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
            onFixScenario={onFixScenario ? () => void fixScenario() : undefined}
            fixRestarts={fixRestarts}
          />
        </DialogActions>
      </Dialog>
    </Box>
  );
}
