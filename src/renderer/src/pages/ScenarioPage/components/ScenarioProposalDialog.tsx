import type { ReactElement } from 'react';
import { Alert, Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, Typography } from '@mui/material';
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

/** Просмотр отделён от публикации: закрытие диалога ничего не применяет. */
export function ScenarioProposalDialog({
  project,
  proposal,
  provider,
  open,
  busy,
  error,
  onApply,
  onClose
}: {
  project: string;
  proposal: ScenarioProposal;
  provider: AgentSettings['provider'] | null;
  open: boolean;
  busy: boolean;
  error: string | null;
  onApply(): void;
  onClose(): void;
}): ReactElement {
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="xl" fullWidth>
      <DialogTitle>
        <AgentIcon provider={provider} /> Предложение: сравнение с сохранённым проектом
      </DialogTitle>
      <DialogContent dividers>
        <Stack spacing={3}>
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
      <DialogActions>
        <Button startIcon={<CloseIcon />} disabled={busy} onClick={onClose}>
          Закрыть без применения
        </Button>
        <DestructiveButton
          label={proposal.pass === 'treatment' ? 'Применить и утвердить кастинг и трактовку' : 'Применить сценарий'}
          description="Предложение будет записано в проект и заменит соответствующие сохранённые данные."
          confirmLabel="Применить"
          startIcon={<CheckIcon />}
          variant="contained"
          disabled={busy || proposal.stale || proposal.status !== 'ready'}
          onConfirm={onApply}
        />
      </DialogActions>
    </Dialog>
  );
}
