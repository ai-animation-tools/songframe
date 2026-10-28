import { useState, type ReactElement, type Ref } from 'react';
import { Link } from 'react-router-dom';
import { Box, Chip, Divider, ListItemIcon, ListItemText, Menu, MenuItem, Stack, Tooltip, Typography } from '@mui/material';
import { ErrorOutline, FileDownload, MoreVert, OndemandVideo, Redo, Refresh, Save, SaveAs, Undo, WarningAmber } from '@mui/icons-material';
import { FPS } from '@shared/video';
import { ActionButton } from '../../../components/ActionButton';
import { ActionIconButton } from '../../../components/ActionIconButton';
import { JobStatus } from '../../../components/JobStatus';
import { PageActionBar } from '../../../components/PageActionBar';

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
  onUndo: () => void;
  onRedo: () => void;
  onSave: () => void;
  onSaveAsNew: () => void;
  onReopen: () => void;
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
  const { locked, running, exportProblem, stale } = props;
  const [menuAnchor, setMenuAnchor] = useState<HTMLElement | null>(null);
  const closeMenu = (): void => setMenuAnchor(null);
  const fromMenu = (action: () => void) => (): void => {
    closeMenu();
    action();
  };
  // Причина блокировки панели: задание экспорта/применения или короткая операция (чтение, сохранение).
  const lockedReason = running ? 'Дождитесь завершения задания.' : locked ? 'Дождитесь завершения текущей операции.' : null;
  const applyHint = running
    ? 'Дождитесь завершения задания'
    : exportProblem
      ? exportProblem
      : stale
        ? 'Материалы изменились после создания черновика: переоткройте их и соберите монтаж заново.'
        : 'Изменит принятые монтажные версии сцен; перед применением покажем новые границы.';
  return (
    <PageActionBar barRef={props.barRef}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap" useFlexGap sx={{ minWidth: 0 }}>
        <Typography variant="h5">Монтаж пробы</Typography>
        {/* Частота кадров постоянна и не требует места в панели: она в подсказке состояния пробы. */}
        <Tooltip title={`Проба «${props.name}» · ${FPS} кадров/с`}>
          <Chip
            size="small"
            color={props.dirty ? 'warning' : props.saved ? 'success' : 'default'}
            variant="outlined"
            label={props.dirty ? 'Есть несохранённые правки' : props.saved ? 'Черновик сохранён' : 'Новая проба'}
          />
        </Tooltip>
        {exportProblem && props.exportProblemLabel ? (
          <Tooltip title={`${exportProblem} Нажмите, чтобы показать сведения под дорожкой.`}>
            <Chip size="small" color="warning" icon={<WarningAmber />} label={props.exportProblemLabel} onClick={props.onShowProblem} />
          </Tooltip>
        ) : null}
      </Stack>
      <Box sx={{ flex: 1 }} />
      <Stack direction="row" spacing={1} alignItems="center" sx={{ ml: 'auto', flexShrink: 0 }}>
        {running ? (
          <JobStatus running label={props.jobAction === 'apply' ? 'Применение к сценам…' : 'Экспорт MP4…'} />
        ) : props.exportReady ? (
          <Chip color="success" variant="outlined" icon={<OndemandVideo />} label="Проба MP4 готова" onClick={props.onOpenVideo} />
        ) : props.jobFailed ? (
          <Tooltip title="Открыть журнал заданий">
            <Chip color="error" variant="outlined" icon={<ErrorOutline />} label="Задание не выполнено" component={Link} to="/jobs" clickable />
          </Tooltip>
        ) : null}
        <ActionIconButton
          aria-label="Отменить шаг"
          title="Отменить шаг (Ctrl+Z)"
          disabled={locked || !props.canUndo}
          disabledReason={lockedReason ?? 'Нет шагов для отмены.'}
          onClick={props.onUndo}
        >
          <Undo />
        </ActionIconButton>
        <ActionIconButton
          aria-label="Повторить шаг"
          title="Повторить шаг (Ctrl+Shift+Z)"
          disabled={locked || !props.canRedo}
          disabledReason={lockedReason ?? 'Нет отменённых шагов для повтора.'}
          onClick={props.onRedo}
        >
          <Redo />
        </ActionIconButton>
        <ActionButton startIcon={<FileDownload />} disabled={locked || !!exportProblem} disabledReason={lockedReason ?? exportProblem} onClick={props.onExport}>
          Экспортировать MP4
        </ActionButton>
        <ActionIconButton
          aria-label="Ещё"
          aria-haspopup="menu"
          aria-expanded={menuAnchor ? true : undefined}
          onClick={(event) => setMenuAnchor(event.currentTarget)}
        >
          <MoreVert />
        </ActionIconButton>
        <ActionButton
          variant="contained"
          startIcon={<Save />}
          disabled={locked || !props.hasAudio}
          disabledReason={lockedReason ?? 'В проекте нет музыкальной дорожки.'}
          onClick={props.onSave}
        >
          Сохранить черновик
        </ActionButton>
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
          <ListItemText>Переоткрыть материалы</ListItemText>
        </MenuItem>
        <MenuItem disabled={locked || !props.hasAudio} onClick={fromMenu(props.onSaveAsNew)}>
          <ListItemIcon>
            <SaveAs fontSize="small" />
          </ListItemIcon>
          <ListItemText>Сохранить как новый</ListItemText>
        </MenuItem>
        {props.exportReady ? <Divider /> : null}
        {props.exportReady ? (
          <MenuItem onClick={fromMenu(props.onOpenVideo)}>
            <ListItemIcon>
              <OndemandVideo fontSize="small" />
            </ListItemIcon>
            <ListItemText>Просмотреть пробу MP4</ListItemText>
          </MenuItem>
        ) : null}
        {props.exportReady ? (
          <MenuItem disabled={props.busy} onClick={fromMenu(props.onSaveVideo)}>
            <ListItemIcon>
              <FileDownload fontSize="small" />
            </ListItemIcon>
            <ListItemText>Сохранить MP4 как</ListItemText>
          </MenuItem>
        ) : null}
        <Divider />
        {/* Применение меняет принятые сцены, поэтому открывает прежнее подтверждение с новыми границами. */}
        <MenuItem disabled={locked || !!exportProblem || stale} onClick={fromMenu(props.onApply)} sx={{ color: 'error.main' }}>
          <ListItemIcon sx={{ color: 'inherit' }}>
            <WarningAmber fontSize="small" />
          </ListItemIcon>
          <ListItemText primary="Применить к сценам" secondary={applyHint} slotProps={{ secondary: { sx: { maxWidth: 320, whiteSpace: 'normal' } } }} />
        </MenuItem>
      </Menu>
    </PageActionBar>
  );
}
