import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import type { ReactElement } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogTitle, Stack, TextField, Typography } from '@mui/material';
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
      <DialogTitle>Доработать выбранный план</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ pt: 1 }}>
          <Typography>Планы: {ids.join(', ') || 'не выбраны'}. Соседние планы используются как контекст; их постановка не меняется.</Typography>
          <TextField autoFocus multiline minRows={4} label="Что нужно изменить" value={note} onChange={(event) => onNote(event.target.value)} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button startIcon={<CancelOutlinedIcon />} disabled={busy} onClick={onClose}>
          Отмена
        </Button>
        <AgentButton disabled={busy || !ids.length || !note.trim()} variant="contained" onClick={onStart}>
          Подготовить доработку
        </AgentButton>
      </DialogActions>
    </Dialog>
  );
}
