import { scenarioTexts } from '@shared/texts/scenario';
import { commonTexts } from '@shared/texts/common';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import type { ReactElement } from 'react';
import { Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import { AgentButton } from '../../../components/AgentButton';

/** Доработка ограничена выбранным планом и требует содержательного замечания. */
export function ScenarioReviseDialog({
  open,
  ids,
  note,
  busy,
  onNote,
  onStart,
  onClose
}: {
  open: boolean;
  ids: string[];
  note: string;
  busy: boolean;
  onNote(note: string): void;
  onStart(): void;
  onClose(): void;
}): ReactElement {
  return (
    <Dialog open={open} onClose={busy ? undefined : onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{scenarioTexts.revise.title}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography>{scenarioTexts.revise.context({ ids })}</Typography>
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
