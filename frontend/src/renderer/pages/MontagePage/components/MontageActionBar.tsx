import { navigationTexts } from '@shared/texts/navigation';
import { commonTexts } from '@shared/texts/common';
import { montageTexts } from '@shared/texts/montage';
import { useState, type ReactElement, type Ref } from 'react';
import { Link } from 'react-router-dom';
import { Box, Chip, Divider, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material';
import { DeleteOutline, ErrorOutline, FileDownload, MoreVert, OndemandVideo, Redo, Refresh, Save, SaveAs, Undo, WarningAmber } from '@mui/icons-material';
import { ActionButton } from '../../../components/ActionButton';
import { ActionIconButton } from '../../../components/ActionIconButton';
import { JobStatus } from '../../../components/JobStatus';
import { PageActionBar } from '../../../components/PageActionBar';
import { useProjectFps } from '../../../hooks/useProjectFps';

interface Props {
  barRef: Ref<HTMLDivElement>;
  /** Сохранение, чтение или задание: правки и запуск операций недоступны. */
  locked: boolean;
  running: boolean;
  jobAction: 'export' | 'apply' | null;
  jobFailed: boolean;
  exportReady: boolean;
  /** Короткая операция (например, сохранение MP4) ещё выполняется. */
  busy: boolean;
  name: string;
  dirty: boolean;
  saved: boolean;
  hasAudio: boolean;
  canUndo: boolean;
  canRedo: boolean;
  /** Полная причина недоступности экспорта и применения. */
  exportProblem: string | null;
  exportProblemLabel: string | null;
  stale: boolean;
  /** Применение к планам недоступно до утверждения актуального сценария; правка, сохранение и проба доступны. */
  applyBlockedReason: string | null;
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onSaveAsNew: () => void;
  onReopen: () => void;
  onRemoveDraft: () => void;
  onExport: () => void;
  onApply: () => void;
  onShowProblem: () => void;
  onOpenVideo: () => void;
  onSaveVideo: () => void;
}

/**
 * Панель монтажа помещается в одну строку на обычной ширине окна:
 * редкие действия и действия с готовой пробой собраны в меню «Ещё».
 */
export function MontageActionBar(props: Props): ReactElement {
  const fps = useProjectFps();
  const { locked, running, exportProblem, stale, applyBlockedReason } = props;
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const closeMenu = (): void => setMenuAnchor(null);
  const fromMenu = (action: () => void) => (): void => {
    closeMenu();
    action();
  };
  // Причина блокировки панели: задание экспорта/применения или короткая операция (чтение, сохранение).
  const lockedReason = running ? montageTexts.jobPending : locked ? commonTexts.operationPending : null;
  const applyHint = running ? montageTexts.jobPendingHint : (applyBlockedReason ?? exportProblem ?? (stale ? montageTexts.staleApply : montageTexts.applyHint));
  return (
    <PageActionBar barRef={props.barRef}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ minWidth: 0 }}>
        <Typography variant="h5">{navigationTexts.pages.montage}</Typography>
        {/* Частота кадров постоянна и не требует места в панели: она в подсказке состояния пробы. */}
        <Tooltip title={montageTexts.draftStatus({ name: props.name, fps: fps })}>
          <Chip
            size="small"
            color={props.dirty ? 'warning' : props.saved ? 'success' : 'default'}
            variant="outlined"
            label={props.dirty ? montageTexts.unsavedChanges : props.saved ? montageTexts.savedDraftStatus : montageTexts.newDraft}
          />
        </Tooltip>
        {exportProblem && props.exportProblemLabel ? (
          <Tooltip title={montageTexts.showExportProblem(exportProblem)}>
            <Chip size="small" color="warning" icon={<WarningAmber />} label={props.exportProblemLabel} onClick={props.onShowProblem} />
          </Tooltip>
        ) : null}
      </Stack>
      <Box sx={{ flex: 1 }} />
      <Stack direction="row" spacing={1} alignItems="center" sx={{ ml: 'auto', flexShrink: 0 }}>
        {running ? (
          <JobStatus running label={props.jobAction === 'apply' ? montageTexts.applying : montageTexts.exporting} />
        ) : props.exportReady ? (
          <Chip color="success" variant="outlined" icon={<OndemandVideo />} label={montageTexts.exportReady} onClick={props.onOpenVideo} />
        ) : props.jobFailed ? (
          <Tooltip title={montageTexts.openJobs}>
            <Chip color="error" variant="outlined" icon={<ErrorOutline />} label={montageTexts.jobFailed} component={Link} to="/jobs" clickable />
          </Tooltip>
        ) : null}
        <ActionIconButton
          aria-label={montageTexts.undo}
          title={montageTexts.undoHint}
          disabled={locked || !props.canUndo}
          disabledReason={lockedReason ?? montageTexts.undoUnavailable}
          onClick={props.onUndo}
        >
          <Undo />
        </ActionIconButton>
        <ActionIconButton
          aria-label={montageTexts.redo}
          title={montageTexts.redoHint}
          disabled={locked || !props.canRedo}
          disabledReason={lockedReason ?? montageTexts.redoUnavailable}
          onClick={props.onRedo}
        >
          <Redo />
        </ActionIconButton>
        <ActionButton startIcon={<FileDownload />} disabled={locked || !!exportProblem} disabledReason={lockedReason ?? exportProblem} onClick={props.onExport}>
          {montageTexts.exportVideo}
        </ActionButton>
        <ActionButton
          variant="contained"
          startIcon={<Save />}
          disabled={locked || !props.hasAudio}
          disabledReason={lockedReason ?? montageTexts.noTrack}
          onClick={props.onSave}
        >
          {montageTexts.saveDraft}
        </ActionButton>
        <ActionIconButton
          aria-label={montageTexts.more}
          aria-haspopup="menu"
          aria-expanded={menuAnchor ? true : undefined}
          onClick={(event) => setMenuAnchor(event.currentTarget)}
        >
          <MoreVert />
        </ActionIconButton>
      </Stack>
      <Menu
        anchorEl={menuAnchor}
        open={!!menuAnchor}
        onClose={closeMenu}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
      >
        <MenuItem disabled={locked} onClick={fromMenu(props.onReopen)}>
          <ListItemIcon>
            <Refresh fontSize="small" />
          </ListItemIcon>
          <ListItemText>{montageTexts.reopenMaterials}</ListItemText>
        </MenuItem>
        <MenuItem disabled={locked || !props.hasAudio} onClick={fromMenu(props.onSaveAsNew)}>
          <ListItemIcon>
            <SaveAs fontSize="small" />
          </ListItemIcon>
          <ListItemText>{montageTexts.saveAsNew}</ListItemText>
        </MenuItem>
        <MenuItem disabled={locked || !props.saved} onClick={fromMenu(props.onRemoveDraft)}>
          <ListItemIcon>
            <DeleteOutline fontSize="small" />
          </ListItemIcon>
          <ListItemText>{montageTexts.removeDraft}</ListItemText>
        </MenuItem>
        {props.exportReady ? <Divider /> : null}
        {props.exportReady ? (
          <MenuItem onClick={fromMenu(props.onOpenVideo)}>
            <ListItemIcon>
              <OndemandVideo fontSize="small" />
            </ListItemIcon>
            <ListItemText>{montageTexts.watchExport}</ListItemText>
          </MenuItem>
        ) : null}
        {props.exportReady ? (
          <MenuItem disabled={props.busy} onClick={fromMenu(props.onSaveVideo)}>
            <ListItemIcon>
              <FileDownload fontSize="small" />
            </ListItemIcon>
            <ListItemText>{montageTexts.saveVideoAs}</ListItemText>
          </MenuItem>
        ) : null}
        <Divider />
        {/* Применение меняет принятые сцены, поэтому открывает прежнее подтверждение с новыми границами. */}
        <MenuItem disabled={locked || !!applyBlockedReason || !!exportProblem || stale} onClick={fromMenu(props.onApply)} sx={{ color: 'error.main' }}>
          <ListItemIcon sx={{ color: 'inherit' }}>
            <WarningAmber fontSize="small" />
          </ListItemIcon>
          <ListItemText primary={montageTexts.applyToScenes} secondary={applyHint} slotProps={{ secondary: { sx: { maxWidth: 320, whiteSpace: 'normal' } } }} />
        </MenuItem>
      </Menu>
    </PageActionBar>
  );
}
