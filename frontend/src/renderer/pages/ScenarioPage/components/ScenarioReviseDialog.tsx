import { scenarioTexts } from '@shared/texts/scenario';
import { commonTexts } from '@shared/texts/common';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import type { ReactElement } from 'react';
import {
  Alert,
  Box,
  Checkbox,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  FormGroup,
  Stack,
  TextField,
  Typography
} from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import { AgentButton } from '../../../components/AgentButton';

/** План сценария в списке выбора: ID и действие для узнавания. */
export interface ReviseShotOption {
  id: string;
  action: string;
}

/**
 * Доработка ограничена отмеченными планами (одним заданием агента) и требует содержательного замечания.
 * Список планов — в порядке сценария; выбранный на странице план отмечен заранее. Если среди отмеченных
 * есть принятые в производстве планы, окно до запуска называет их и последствия: само окно и есть
 * подтверждение.
 */
export function ScenarioReviseDialog({
  open,
  shots = [],
  ids,
  acceptedIds = [],
  note,
  busy,
  onIds,
  onNote,
  onStart,
  onClose
}: {
  open: boolean;
  /** Все планы сценария; без списка окно показывает только переданные ids. */
  shots?: ReviseShotOption[];
  ids: string[];
  /** Отмеченные планы, принятые в производстве. */
  acceptedIds?: string[];
  note: string;
  busy: boolean;
  /** Новый набор отмеченных планов в порядке сценария. */
  onIds?(ids: string[]): void;
  onNote(note: string): void;
  onStart(): void;
  onClose(): void;
}): ReactElement {
  const toggle = (id: string, checked: boolean): void => {
    const next = new Set(ids);
    if (checked) next.add(id);
    else next.delete(id);
    onIds?.(shots.map((shot) => shot.id).filter((shot) => next.has(shot)));
  };
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{scenarioTexts.revise.dialogTitle}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography>{scenarioTexts.revise.context({ ids })}</Typography>
          {shots.length > 1 && onIds ? (
            <Box sx={{ maxHeight: 240, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: 1, px: 1.5, py: 0.5 }}>
              <FormGroup role="group" aria-label={scenarioTexts.revise.shots}>
                {shots.map((shot) => (
                  <FormControlLabel
                    key={shot.id}
                    disabled={busy}
                    control={<Checkbox size="small" checked={ids.includes(shot.id)} onChange={(event) => toggle(shot.id, event.target.checked)} />}
                    label={
                      <Typography variant="body2" noWrap title={shot.action} sx={{ maxWidth: 480 }}>
                        <strong>{shot.id}</strong> {shot.action}
                      </Typography>
                    }
                  />
                ))}
              </FormGroup>
            </Box>
          ) : null}
          {acceptedIds.length ? (
            <Alert severity="warning">
              {scenarioTexts.accepted.revise({ shots: acceptedIds })} {scenarioTexts.accepted.kept}
            </Alert>
          ) : null}
          <TextField autoFocus multiline minRows={4} label={scenarioTexts.revise.note} value={note} onChange={(event) => onNote(event.target.value)} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <ActionButton startIcon={<CancelOutlinedIcon />} disabled={busy} disabledReason={commonTexts.operationPending} onClick={onClose}>
          {commonTexts.cancel}
        </ActionButton>
        <AgentButton
          disabled={busy || !ids.length || !note.trim()}
          disabledReason={
            busy ? commonTexts.operationPending : !ids.length ? scenarioTexts.revise.selectShot : !note.trim() ? scenarioTexts.revise.explainChanges : null
          }
          variant="contained"
          onClick={onStart}
        >
          {scenarioTexts.revise.prepare}
        </AgentButton>
      </DialogActions>
    </Dialog>
  );
}
