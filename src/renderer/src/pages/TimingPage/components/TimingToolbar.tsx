import type { ReactElement } from 'react';
import { Box, Chip, CircularProgress, Typography } from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import SaveIcon from '@mui/icons-material/Save';
import DoneAllIcon from '@mui/icons-material/DoneAll';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import UndoIcon from '@mui/icons-material/Undo';
import { ActionButton } from '../../../components/ActionButton';
import { DestructiveButton } from '../../../components/DestructiveButton';

interface TimingToolbarProps {
  lineCount: number;
  verifiedCount: number;
  dirty: boolean;
  busy: boolean;
  generating: boolean;
  invalidBindings: boolean;
  canGenerate: boolean;
  /** Почему автоматическая разметка недоступна без правок (нет трека, текста или инструментов). */
  generateBlockedReason: string | null;
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
  dirty,
  busy,
  generating,
  invalidBindings,
  canGenerate,
  generateBlockedReason,
  onGenerate,
  onConfirmAll,
  onRecalculateSections,
  onSave,
  onDiscard
}: TimingToolbarProps): ReactElement {
  const working = busy || generating;
  // Причина видна в подсказке: предупреждения на странице могут быть далеко от панели.
  const waitReason = generating ? 'Дождитесь окончания распознавания.' : busy ? 'Дождитесь окончания текущей операции.' : null;
  const generateReason = waitReason ?? (dirty ? 'Сохраните или отмените правки перед автоматической разметкой.' : generateBlockedReason);
  const invalidBindingsReason = 'Текст песни изменился: сначала повторите автоматическую разметку.';
  const saveReason = working ? null : invalidBindings ? invalidBindingsReason : !dirty ? 'Нет несохранённых правок.' : null;
  return (
    <Box sx={{ display: 'flex', width: '100%', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
        <Typography variant="h5">Тайминги</Typography>
        {lineCount ? (
          <Chip size="small" color={verifiedCount === lineCount ? 'success' : 'warning'} label={`подтверждено ${verifiedCount} из ${lineCount}`} />
        ) : (
          <Chip size="small" variant="outlined" label="разметки нет" />
        )}
        {dirty ? <Chip size="small" color="warning" label="Есть несохранённые правки" /> : null}
      </Box>
      {/* Действия держатся одной группой справа: при переносе «Сохранить» остаётся последней справа. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end', ml: 'auto' }}>
        <ActionButton
          startIcon={generating ? <CircularProgress size={16} /> : <AutoFixHighIcon />}
          title={generating ? undefined : 'Распознать трек и расставить строки текста автоматически'}
          disabled={working || dirty || !canGenerate}
          disabledReason={generateReason}
          onClick={onGenerate}
        >
          {generating ? 'Распознавание' : 'Разметить'}
        </ActionButton>
        <ActionButton
          startIcon={<DoneAllIcon />}
          disabled={working || verifiedCount === lineCount}
          disabledReason={waitReason ?? (lineCount ? 'Все строки уже подтверждены.' : 'Нет строк разметки.')}
          onClick={onConfirmAll}
        >
          Подтвердить все
        </ActionButton>
        <DestructiveButton
          label="Пересчитать секции"
          description="Границы, названия и заметки секций будут заменены по текущим строкам. Результат можно сохранить или отменить вместе с остальными правками."
          confirmLabel="Пересчитать"
          startIcon={<RestartAltIcon />}
          size="medium"
          disabled={working || !lineCount || invalidBindings}
          disabledReason={waitReason ?? (!lineCount ? 'Нет строк разметки.' : invalidBindingsReason)}
          onConfirm={onRecalculateSections}
        />
        {dirty ? (
          <DestructiveButton
            icon
            size="medium"
            startIcon={<UndoIcon />}
            label="Отменить правки"
            description="Несохранённые изменения разметки будут потеряны. Сохранённая разметка останется прежней."
            confirmLabel="Отменить правки"
            disabled={working}
            disabledReason={waitReason}
            onConfirm={onDiscard}
          >
            <UndoIcon />
          </DestructiveButton>
        ) : null}
        <ActionButton
          variant="contained"
          startIcon={<SaveIcon />}
          disabled={working || !!saveReason}
          disabledReason={waitReason ?? saveReason}
          onClick={onSave}
        >
          Сохранить
        </ActionButton>
      </Box>
    </Box>
  );
}
