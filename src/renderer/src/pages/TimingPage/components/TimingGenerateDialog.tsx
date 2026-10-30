import { timingTexts } from '@shared/texts/timing';
import { commonTexts } from '@shared/texts/common';
import { CancelOutlined, PlayArrow } from '@mui/icons-material';
import type { ReactElement } from 'react';
import { Button, Checkbox, Dialog, DialogActions, DialogContent, DialogTitle, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';
import { WhisperModelSetup } from './WhisperModelSetup';

interface TimingGenerateDialogProps {
  open: boolean;
  model: string;
  device: 'auto' | 'cpu';
  resetAll: boolean;
  canGenerate: boolean;
  /** Почему запуск сейчас недоступен; показывается в подсказке кнопки. */
  generateBlockedReason: string | null;
  onClose: () => void;
  onModelChange: (model: string) => void;
  onDeviceChange: (device: 'auto' | 'cpu') => void;
  onResetChange: (reset: boolean) => void;
  onGenerate: () => void;
}

/** Модель настраивается отдельно; диалог собирает параметры локального распознавания. */
export function TimingGenerateDialog({
  open,
  model,
  device,
  resetAll,
  canGenerate,
  generateBlockedReason,
  onClose,
  onModelChange,
  onDeviceChange,
  onResetChange,
  onGenerate
}: TimingGenerateDialogProps): ReactElement {
  return (
    <Dialog open={open} onClose={onClose} maxWidth="sm" fullWidth>
      <DialogTitle>{timingTexts.generateTitle}</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2">{timingTexts.generateDescription}</Typography>
          {open ? <WhisperModelSetup path={model} onPathChange={onModelChange} /> : null}
          <TextField
            select
            label={timingTexts.processing}
            value={device}
            onChange={(event) => onDeviceChange(event.target.value as 'auto' | 'cpu')}
            helperText={timingTexts.processingHint}
          >
            <MenuItem value="auto">{timingTexts.automaticDevice}</MenuItem>
            <MenuItem value="cpu">{timingTexts.cpuOnly}</MenuItem>
          </TextField>
          <FormControlLabel control={<Checkbox checked={resetAll} onChange={(e) => onResetChange(e.target.checked)} />} label={timingTexts.resetAll} />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button startIcon={<CancelOutlined />} onClick={onClose}>
          {commonTexts.cancel}
        </Button>
        <ActionButton
          startIcon={<PlayArrow />}
          variant="contained"
          color={resetAll ? 'error' : 'primary'}
          onClick={onGenerate}
          disabled={!canGenerate}
          disabledReason={generateBlockedReason}
        >
          {commonTexts.run}
        </ActionButton>
      </DialogActions>
    </Dialog>
  );
}
