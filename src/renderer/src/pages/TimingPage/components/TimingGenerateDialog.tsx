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
      <DialogTitle>Автоматическая разметка</DialogTitle>
      <DialogContent>
        <Stack spacing={2} sx={{ mt: 1 }}>
          <Typography variant="body2">
            Трек распознаётся локальной моделью faster-whisper без сети, затем текст песни выравнивается по словам. На CPU это несколько минут. Подтверждённые
            строки сохраняются, если не включён полный пересчёт.
          </Typography>
          {open ? <WhisperModelSetup path={model} onPathChange={onModelChange} /> : null}
          <TextField
            select
            label="Обработка"
            value={device}
            onChange={(event) => onDeviceChange(event.target.value as 'auto' | 'cpu')}
            helperText="Автоматически: CUDA, если она доступна, иначе CPU. При ошибке видеопамяти выберите меньшую модель или CPU."
          >
            <MenuItem value="auto">Автоматически (CPU / NVIDIA CUDA)</MenuItem>
            <MenuItem value="cpu">Только CPU</MenuItem>
          </TextField>
          <FormControlLabel
            control={<Checkbox checked={resetAll} onChange={(e) => onResetChange(e.target.checked)} />}
            label="Пересчитать все строки, включая подтверждённые"
          />
        </Stack>
      </DialogContent>
      <DialogActions>
        <Button startIcon={<CancelOutlined />} onClick={onClose}>
          Отмена
        </Button>
        <ActionButton
          startIcon={<PlayArrow />}
          variant="contained"
          color={resetAll ? 'error' : 'primary'}
          onClick={onGenerate}
          disabled={!canGenerate}
          disabledReason={generateBlockedReason}
        >
          Запустить
        </ActionButton>
      </DialogActions>
    </Dialog>
  );
}
