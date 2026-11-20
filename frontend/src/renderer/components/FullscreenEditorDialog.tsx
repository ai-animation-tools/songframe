import { commonTexts } from '@shared/texts/common';
import { useId, type ReactElement, type ReactNode } from 'react';
import { AppBar, Box, Chip, Dialog, IconButton, Stack, Toolbar, Tooltip, Typography } from '@mui/material';
import CloseFullscreenIcon from '@mui/icons-material/CloseFullscreen';

/**
 * Редактор во весь экран: окно поверх страницы без её панелей, чтобы схеме хватило места и ничего не отвлекало.
 * Правки идут в тот же черновик страницы, поэтому закрытие (кнопка в шапке или Esc) ничего не теряет и закрывает
 * окно сразу, без вопросов. Несохранённые правки видны в шапке, там же кнопки страницы (actions), например
 * «Сохранить».
 */
export function FullscreenEditorDialog({
  open,
  title,
  dirty,
  actions,
  onClose,
  children
}: {
  open: boolean;
  title: string;
  /** Есть несохранённые правки: в шапке заметная отметка. */
  dirty: boolean;
  /** Кнопки шапки слева от «Закрыть», например «Сохранить». */
  actions?: ReactNode;
  onClose(): void;
  children: ReactNode;
}): ReactElement {
  const titleId = useId();
  return (
    <Dialog fullScreen open={open} onClose={onClose} aria-labelledby={titleId}>
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
            <IconButton edge="end" aria-label={commonTexts.close} onClick={onClose}>
              <CloseFullscreenIcon />
            </IconButton>
          </Tooltip>
        </Toolbar>
      </AppBar>
      <Box sx={{ p: 2, flex: 1, minHeight: 0, overflow: 'auto' }}>{children}</Box>
    </Dialog>
  );
}
