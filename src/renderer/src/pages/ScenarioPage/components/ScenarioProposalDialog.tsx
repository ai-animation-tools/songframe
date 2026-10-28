import { useId, type ReactElement } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
import type { ScenarioProposal } from '@shared/scenario-workflow';
import type { AgentSettings } from '@shared/agents';
import { AgentIcon } from '../../../components/AgentIcon';
import { DestructiveButton } from '../../../components/DestructiveButton';
import CloseIcon from '@mui/icons-material/Close';
import CheckIcon from '@mui/icons-material/Check';
import { ScenarioCastComparison } from './ScenarioCastComparison';
import { ScenarioTreatmentComparison } from './ScenarioTreatmentComparison';
import { ScenarioScenesComparison } from './ScenarioScenesComparison';
import { ScenarioContinuityComparison } from './ScenarioContinuityComparison';

const PASS_LABELS: Record<ScenarioProposal['pass'], string> = { treatment: 'Кастинг и трактовка', scenes: 'Сценарий', revise: 'Доработка плана' };

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
      <DialogTitle id={titleId}>Предложение для сценария · {PASS_LABELS[proposal.pass]}</DialogTitle>
      <DialogContent dividers>
        <Stack spacing={3}>
          <Stack direction="row" spacing={1} sx={{ alignItems: 'center' }}>
            {provider ? <AgentIcon provider={provider} /> : null}
            <Typography fontWeight={600}>Предложение агента · {PASS_LABELS[proposal.pass]}</Typography>
          </Stack>
          <Alert severity="info">Предложение ещё не записано в проект. Изменённые поля выделены фоном.</Alert>
          {error && <Alert severity="error">{error}</Alert>}
          {proposal.stale && <Alert severity="warning">Исходные файлы изменились. Предложение устарело: запустите новый проход.</Alert>}
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
              <Typography>Изменённые планы: {proposal.changedIds.join(', ') || 'нет'}</Typography>
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
      <DialogActions sx={{ gap: 1, flexWrap: 'wrap' }}>
        <DestructiveButton
          label={proposal.pass === 'treatment' ? 'Применить и утвердить кастинг и трактовку' : 'Применить сценарий'}
          description="Предложение будет записано в проект и заменит соответствующие сохранённые данные."
          confirmLabel="Применить"
          startIcon={<CheckIcon />}
          variant="contained"
          disabled={busy || proposal.stale || proposal.status !== 'ready'}
          onConfirm={onApply}
        />
        <DestructiveButton
          label="Отклонить предложение"
          description="Предложение будет отклонено без записи в проект."
          confirmLabel="Отклонить"
          disabled={busy}
          onConfirm={onDiscard}
        />
        <Box sx={{ flex: 1 }} />
        <Button startIcon={<CloseIcon />} disabled={busy} onClick={onClose}>
          Закрыть без применения
        </Button>
      </DialogActions>
    </Dialog>
  );
}
