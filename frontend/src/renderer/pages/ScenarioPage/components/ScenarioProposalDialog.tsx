import { scenarioTexts } from '@shared/texts/scenario';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import { useId, type ReactElement } from 'react';
import { Alert, Box, Dialog, DialogActions, DialogContent, DialogTitle, LinearProgress, Stack, Typography } from '@mui/material';
import type { ScenarioProposal } from '@shared/scenario-workflow';
import type { AgentSettings } from '@shared/agents';
import { AgentIcon } from '../../../components/AgentIcon';
import { ActionButton } from '../../../components/ActionButton';
import { DestructiveButton } from '../../../components/DestructiveButton';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import CheckIcon from '@mui/icons-material/Check';
import { ScenarioCastComparison } from './ScenarioCastComparison';
import { ScenarioTreatmentComparison } from './ScenarioTreatmentComparison';
import { ScenarioScenesComparison } from './ScenarioScenesComparison';
import { ScenarioContinuityComparison } from './ScenarioContinuityComparison';

const PASS_LABELS: Record<ScenarioProposal['pass'], string> = {
  treatment: scenarioTexts.proposal.castAndTreatment,
  scenes: navigationTexts.pages.scenario,
  revise: scenarioTexts.proposal.revision
};

/** Просмотр отделён от публикации: закрытие диалога ничего не применяет. Окно и строка действий такие же, как у производства. */
export function ScenarioProposalDialog({
  project,
  proposal,
  provider,
  open,
  busy,
  error,
  onApply,
  onDiscard,
  onClose
}: {
  project: string;
  proposal: ScenarioProposal;
  provider: AgentSettings['provider'] | null;
  open: boolean;
  busy: boolean;
  error: string | null;
  onApply(): void;
  onDiscard(): void;
  onClose(): void;
}): ReactElement {
  const titleId = useId();
  return (
    <Dialog
      open={open}
      onClose={busy ? undefined : onClose}
      aria-labelledby={titleId}
      maxWidth={false}
      fullWidth
      slotProps={{ paper: { sx: { width: 'calc(100% - 32px)', height: 'calc(100% - 32px)', maxHeight: 'calc(100% - 32px)', m: 2 } } }}
    >
      <DialogTitle id={titleId}>{scenarioTexts.proposal.scenarioTitle({ pass: PASS_LABELS[proposal.pass] })}</DialogTitle>
      {/* Запись большого реестра занимает десятки секунд: показываем, что работа идёт. */}
      {busy ? <LinearProgress aria-label={scenarioTexts.proposal.applying} /> : null}
      <DialogContent dividers>
        <Stack spacing={3}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            {provider ? <AgentIcon provider={provider} /> : null}
            <Typography fontWeight={600}>{scenarioTexts.proposal.agentTitle({ pass: PASS_LABELS[proposal.pass] })}</Typography>
          </Stack>
          <Alert severity="info">{scenarioTexts.proposal.notApplied}</Alert>
          {error && <Alert severity="error">{error}</Alert>}
          {proposal.stale && <Alert severity="warning">{scenarioTexts.proposal.sourcesChanged}</Alert>}
          {proposal.warnings.map((warning) => (
            <Alert key={warning} severity="warning">
              {warning}
            </Alert>
          ))}
          {proposal.pass === 'treatment' ? (
            <>
              <ScenarioCastComparison before={proposal.before.cast} after={proposal.after.cast} />
              <ScenarioTreatmentComparison before={proposal.before.treatment} after={proposal.after.treatment} />
            </>
          ) : (
            <>
              <Typography>{scenarioTexts.proposal.changedShots({ ids: proposal.changedIds })}</Typography>
              <ScenarioScenesComparison
                before={proposal.before.scenes}
                after={proposal.after.scenes}
                selectedIds={proposal.selectedIds}
                changedIds={proposal.changedIds}
              />
              {proposal.pass === 'revise' && proposal.before.scenes && proposal.after.scenes && (
                <ScenarioContinuityComparison
                  project={project}
                  before={proposal.before.scenes}
                  after={proposal.after.scenes}
                  selectedIds={proposal.selectedIds}
                />
              )}
            </>
          )}
        </Stack>
      </DialogContent>
      {/* Порядок как в подтверждениях: закрытие без действия слева, применение последним справа. */}
      <DialogActions sx={{ gap: 1, flexWrap: 'wrap' }}>
        <ActionButton startIcon={<CancelOutlinedIcon />} disabled={busy} disabledReason={commonTexts.operationPending} onClick={onClose}>
          {scenarioTexts.proposal.close}
        </ActionButton>
        <Box sx={{ flex: 1 }} />
        <DestructiveButton
          label={scenarioTexts.proposal.discard}
          description={scenarioTexts.proposal.discardDescription}
          confirmLabel={scenarioTexts.proposal.discardConfirm}
          disabled={busy}
          disabledReason={commonTexts.operationPending}
          onConfirm={onDiscard}
        />
        <DestructiveButton
          label={proposal.pass === 'treatment' ? scenarioTexts.proposal.applyTreatment : scenarioTexts.proposal.applyScenes}
          description={scenarioTexts.proposal.applyDescription}
          confirmLabel={commonTexts.apply}
          startIcon={<CheckIcon />}
          variant="contained"
          disabled={busy || proposal.stale || proposal.status !== 'ready'}
          disabledReason={
            busy
              ? commonTexts.operationPending
              : proposal.stale
                ? scenarioTexts.proposal.staleReason
                : proposal.status !== 'ready'
                  ? scenarioTexts.proposal.notReady
                  : null
          }
          onConfirm={onApply}
        />
      </DialogActions>
    </Dialog>
  );
}
