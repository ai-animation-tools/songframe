import type { ReactElement } from 'react';
import { Box, Button, Chip, CircularProgress, Typography } from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import SaveIcon from '@mui/icons-material/Save';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import { DestructiveButton } from '../../../components/DestructiveButton';

interface TimingToolbarProps {
  lineCount: number;
  verifiedCount: number;
  sectionCount: number;
  dirty: boolean;
  busy: boolean;
  generating: boolean;
  invalidBindings: boolean;
  canGenerate: boolean;
  onGenerate: () => void;
  onConfirmAll: () => void;
  onRecalculateSections: () => void;
  onSave: () => void;
  onDiscard: () => void;
}

/** Команды редактора учитывают несохранённые правки и текущую операцию. */
export function TimingToolbar({
  lineCount,
  verifiedCount,
  sectionCount,
  dirty,
  busy,
  generating,
  invalidBindings,
  canGenerate,
  onGenerate,
  onConfirmAll,
  onRecalculateSections,
  onSave,
  onDiscard
}: TimingToolbarProps): ReactElement {
  return (
    <Box sx={{ display: 'flex', width: '100%', alignItems: 'center', gap: 2, flexWrap: 'wrap' }}>
      <Typography variant="h5">Тайминги</Typography>
      {lineCount ? (
        <Chip size="small" color={verifiedCount === lineCount ? 'success' : 'warning'} label={`подтверждено ${verifiedCount} из ${lineCount}`} />
      ) : (
        <Chip size="small" variant="outlined" label="разметки нет" />
      )}
      {sectionCount ? <Chip size="small" variant="outlined" label={`секций: ${sectionCount}`} /> : null}
      <Box sx={{ flex: 1 }} />
      <Button
        variant="outlined"
        startIcon={generating ? <CircularProgress size={16} /> : <AutoFixHighIcon />}
        disabled={busy || generating || dirty || !canGenerate}
        onClick={onGenerate}
      >
        {generating ? 'Распознавание' : 'Разметить автоматически'}
      </Button>
      <Button startIcon={<DoneAllIcon />} disabled={busy || generating || verifiedCount === lineCount} onClick={onConfirmAll}>
        Подтвердить все
      </Button>
      <DestructiveButton
        label="Пересчитать секции"
        description="Границы, названия и заметки секций будут заменены по текущим строкам. Результат можно сохранить или отменить вместе с остальными правками."
        confirmLabel="Пересчитать"
        startIcon={<RestartAltIcon />}
        disabled={busy || generating || !lineCount || invalidBindings}
        onConfirm={onRecalculateSections}
      />
      <Button variant="contained" startIcon={<SaveIcon />} disabled={busy || generating || !dirty || invalidBindings} onClick={onSave}>
        Сохранить
      </Button>
      {dirty ? (
        <DestructiveButton
          startIcon={<RestartAltIcon />}
          label="Отменить правки"
          description="Несохранённые изменения разметки будут потеряны. Сохранённая разметка останется прежней."
          confirmLabel="Отменить правки"
          disabled={busy || generating}
          onConfirm={onDiscard}
        />
      ) : null}
    </Box>
  );
}
