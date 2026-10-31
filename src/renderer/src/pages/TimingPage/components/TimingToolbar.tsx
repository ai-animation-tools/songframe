import { timingTexts } from '@shared/texts/timing';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
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
  const waitReason = generating ? timingTexts.recognitionPending : busy ? timingTexts.operationPending : null;
  const generateReason = waitReason ?? (dirty ? timingTexts.saveBeforeGenerate : generateBlockedReason);
  const invalidBindingsReason = timingTexts.invalidBindings;
  const saveReason = working ? null : invalidBindings ? invalidBindingsReason : !dirty ? timingTexts.noUnsavedChanges : null;
  return (
    <Box sx={{ display: 'flex', width: '100%', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', minWidth: 0 }}>
        <Typography variant="h5">{navigationTexts.pages.timing}</Typography>
        {lineCount ? (
          <Chip
            size="small"
            color={verifiedCount === lineCount ? 'success' : 'warning'}
            label={timingTexts.verifiedCount({ verified: verifiedCount, total: lineCount })}
          />
        ) : (
          <Chip size="small" variant="outlined" label={timingTexts.noTiming} />
        )}
        {dirty ? <Chip size="small" color="warning" label={commonTexts.unsavedChanges} /> : null}
      </Box>
      {/* Действия держатся одной группой справа: при переносе «Сохранить» остаётся последней справа. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end', ml: 'auto' }}>
        <ActionButton
          startIcon={generating ? <CircularProgress size={16} aria-hidden /> : <AutoFixHighIcon />}
          title={generating ? undefined : timingTexts.generateHint}
          disabled={working || dirty || !canGenerate}
          disabledReason={generateReason}
          onClick={onGenerate}
        >
          {generating ? timingTexts.recognizing : timingTexts.generate}
        </ActionButton>
        <ActionButton
          startIcon={<DoneAllIcon />}
          disabled={working || verifiedCount === lineCount}
          disabledReason={waitReason ?? (lineCount ? timingTexts.allVerified : timingTexts.noLines)}
          onClick={onConfirmAll}
        >
          {timingTexts.verifyAll}
        </ActionButton>
        <DestructiveButton
          label={timingTexts.recalculateSections}
          description={timingTexts.recalculateDescription}
          confirmLabel={timingTexts.recalculate}
          startIcon={<RestartAltIcon />}
          size="medium"
          disabled={working || !lineCount || invalidBindings}
          disabledReason={waitReason ?? (!lineCount ? timingTexts.noLines : invalidBindingsReason)}
          onConfirm={onRecalculateSections}
        />
        {dirty ? (
          <DestructiveButton
            icon
            size="medium"
            startIcon={<UndoIcon />}
            label={timingTexts.discard}
            description={timingTexts.discardDescription}
            confirmLabel={timingTexts.discard}
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
          {commonTexts.save}
        </ActionButton>
      </Box>
    </Box>
  );
}
