import { timingTexts } from '@shared/texts/timing';
import { commonTexts } from '@shared/texts/common';
import { navigationTexts } from '@shared/texts/navigation';
import { useState, type ReactElement } from 'react';
import { Box, Chip, CircularProgress, ListItemIcon, Menu, MenuItem, Typography } from '@mui/material';
import AutoFixHighIcon from '@mui/icons-material/AutoFixHigh';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import { timingEditorTexts } from '@shared/texts/timing-editor';
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
  manualMode?: boolean;
  onManualModeChange?(manual: boolean): void;
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
  manualMode = false,
  onManualModeChange,
  invalidBindings,
  canGenerate,
  generateBlockedReason,
  onGenerate,
  onConfirmAll,
  onRecalculateSections,
  onSave,
  onDiscard
}: TimingToolbarProps): ReactElement {
  const [recognizeAnchor, setRecognizeAnchor] = useState<HTMLElement | null>(null);
  const [moreAnchor, setMoreAnchor] = useState<HTMLElement | null>(null);
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
      {manualMode && <Chip size="small" variant="outlined" icon={<EditOutlinedIcon />} label={timingEditorTexts.mode} />}
      {/* Действия держатся одной группой справа: при переносе «Сохранить» остаётся последней справа. */}
      <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap', justifyContent: 'flex-end', ml: 'auto' }}>
        <ActionButton
          startIcon={generating ? <CircularProgress size={16} aria-hidden /> : <AutoFixHighIcon />}
          endIcon={<ExpandMoreIcon />}
          disabled={working}
          disabledReason={waitReason}
          aria-haspopup="menu"
          aria-expanded={!!recognizeAnchor}
          onClick={(event) => setRecognizeAnchor(event.currentTarget)}
        >
          {generating ? timingTexts.recognizing : timingEditorTexts.recognize}
        </ActionButton>
        <Menu anchorEl={recognizeAnchor} open={!!recognizeAnchor} onClose={() => setRecognizeAnchor(null)}>
          <MenuItem
            disabled={working || dirty || !canGenerate}
            title={generateReason ?? undefined}
            onClick={() => {
              setRecognizeAnchor(null);
              onGenerate();
            }}
          >
            <ListItemIcon>
              <AutoFixHighIcon fontSize="small" />
            </ListItemIcon>
            {timingEditorTexts.automatic}
          </MenuItem>
          <MenuItem
            disabled={working || !onManualModeChange}
            onClick={() => {
              setRecognizeAnchor(null);
              onManualModeChange?.(true);
            }}
          >
            <ListItemIcon>
              <EditOutlinedIcon fontSize="small" />
            </ListItemIcon>
            {timingEditorTexts.manual}
          </MenuItem>
        </Menu>
        <ActionButton
          startIcon={<MoreHorizIcon />}
          onClick={(event) => setMoreAnchor(event.currentTarget)}
          disabled={working}
          disabledReason={waitReason}
          aria-haspopup="menu"
        >
          {timingEditorTexts.more}
        </ActionButton>
        <Menu anchorEl={moreAnchor} open={!!moreAnchor} onClose={() => setMoreAnchor(null)}>
          <MenuItem
            disabled={working || !lineCount || verifiedCount === lineCount}
            onClick={() => {
              setMoreAnchor(null);
              onConfirmAll();
            }}
          >
            <ListItemIcon>
              <DoneAllIcon fontSize="small" />
            </ListItemIcon>
            {timingTexts.verifyAll}
          </MenuItem>
          <Box sx={{ px: 1 }}>
            <DestructiveButton
              label={timingTexts.recalculateSections}
              description={timingTexts.recalculateDescription}
              confirmLabel={timingTexts.recalculate}
              startIcon={<RestartAltIcon />}
              disabled={working || !lineCount || invalidBindings}
              disabledReason={waitReason ?? (!lineCount ? timingTexts.noLines : invalidBindingsReason)}
              onConfirm={() => {
                setMoreAnchor(null);
                onRecalculateSections();
              }}
            />
          </Box>
        </Menu>
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
