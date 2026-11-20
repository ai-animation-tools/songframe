import { commonTexts } from '@shared/texts/common';
import { useId, useState, type ReactElement, type ReactNode } from 'react';
import { AppBar, Box, Button, Chip, Dialog, IconButton, Stack, Toolbar, Tooltip, Typography } from '@mui/material';
import CloseIcon from '@mui/icons-material/Close';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';
import { ConfirmationDialog } from './ConfirmationDialog';

/**
 * Редактор во весь экран: окно поверх страницы без её панелей, чтобы схеме хватило места и ничего не отвлекало.
 * Правки идут в тот же черновик страницы. Закрыть окно можно только кнопкой в шапке или Esc; при несохранённых
 * правках закрытие подтверждается: окно объясняет (closeText), что станет с черновиком, и даёт сохранить
 * (saveAction) или закрыть, оставив черновик. Без несохранённых правок окно закрывается сразу.
 */
export function FullscreenEditorDialog({
  open,
  title,
  dirty,
  closeText,
  actions,
  saveAction,
  onClose,
  children
}: {
  open: boolean;
  title: string;
  /** Есть несохранённые правки: закрытие подтверждается. */
  dirty: boolean;
  /** Что станет с правками после закрытия. */
  closeText: string;
  /** Кнопки шапки слева от «Закрыть», например «Сохранить». */
  actions?: ReactNode;
  /** Кнопка «Сохранить и закрыть» окна подтверждения; нет — только «Закрыть, черновик останется». */
  saveAction?: { label: string; icon: ReactNode; run(): Promise<boolean> };
  onClose(): void;
  children: ReactNode;
}): ReactElement {
  const [confirm, setConfirm] = useState(false);
  const titleId = useId();
  const request = (): void => (dirty ? setConfirm(true) : onClose());
  return (
    <Dialog
      fullScreen
      open={open}
      onClose={(_, reason) => {
        // Esc закрывает так же, как кнопка: через подтверждение.
        if (reason === 'escapeKeyDown') request();
      }}
      aria-labelledby={titleId}
    >
      <AppBar position="sticky" color="default" elevation={1}>
        <Toolbar variant="dense" sx={{ gap: 1.5 }}>
          <Typography id={titleId} variant="h6" sx={{ flex: 1, minWidth: 0 }} noWrap>
            {title}
          </Typography>
          {dirty ? <Chip size="small" color="warning" label={commonTexts.unsavedChanges} /> : null}
          <Stack direction="row" spacing={1}>
            {actions}
          </Stack>
          <Tooltip title={commonTexts.close}>
            <IconButton edge="end" aria-label={commonTexts.close} onClick={request}>
              {dirty ? <CloseIcon /> : <CloseFullscreenIcon />}
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>
      <Box sx={{ p: 2, flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</Box>
      <ConfirmationDialog
        open={confirm}
        title={commonTexts.fullscreen.closeTitle}
        description={closeText}
        cancelLabel={commonTexts.fullscreen.stay}
        confirmLabel={saveAction?.label ?? commonTexts.fullscreen.closeKeep}
        confirmIcon={saveAction?.icon ?? <CloseIcon />}
        extraActions={
          saveAction ? (
            <Button
              startIcon={<CloseIcon />}
              onClick={() => {
                setConfirm(false);
                onClose();
              }}
            >
              {commonTexts.fullscreen.closeKeep}
            </Button>
          ) : null
        }
        onClose={() => setConfirm(false)}
        onConfirm={() => {
          if (!saveAction) {
            setConfirm(false);
            onClose();
            return;
          }
          void saveAction.run().then((saved) => {
            setConfirm(false);
            if (saved) onClose();
          });
        }}
      />
    </Dialog>
  );
}
