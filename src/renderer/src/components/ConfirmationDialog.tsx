import { commonTexts } from '@shared/texts/common';
import { useId, type ReactElement, type ReactNode } from 'react';
import { Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import type { AgentProvider } from '@shared/agent-providers';
import type { AiActionKind } from '@shared/ai-access';
import { ActionButton } from './ActionButton';
import { AgentButton } from './AgentButton';

interface Props {
  open: boolean;
  title: ReactNode;
  description?: ReactNode;
  children?: ReactNode;
  onClose(): void;
  onConfirm(): void;
  confirmLabel: string;
  /** Обычное подтверждение; для действия агента вместо значка передаётся confirmAgent. */
  confirmIcon?: ReactNode;
  /** Подтверждение выполняет агент: кнопка становится AgentButton с его знаком. */
  confirmAgent?: { provider?: AgentProvider; aiKind?: AiActionKind };
  confirmColor?: 'primary' | 'error' | 'warning';
  confirmDisabled?: boolean;
  /** Что мешает подтвердить и что сделать; видно в подсказке выключенной кнопки. */
  confirmDisabledReason?: string | null;
  cancelDisabled?: boolean;
  /** Почему нельзя закрыть диалог сейчас, например во время операции. */
  cancelDisabledReason?: string | null;
  closeDisabled?: boolean;
  cancelLabel?: string;
  cancelAutoFocus?: boolean;
  extraActions?: ReactNode;
  /** Подпись содержимого, которое может не поместиться: область прокрутки получает фокус для клавиатуры. */
  contentLabel?: string;
}

/** Единое оформление подтверждения; решение и ограничения операции остаются у вызывающей страницы. */
export function ConfirmationDialog({
  open,
  title,
  description,
  children,
  onClose,
  onConfirm,
  confirmLabel,
  confirmIcon,
  confirmAgent,
  confirmColor = 'primary',
  confirmDisabled = false,
  confirmDisabledReason,
  cancelDisabled = false,
  cancelDisabledReason,
  closeDisabled = false,
  cancelLabel = commonTexts.cancel,
  cancelAutoFocus = false,
  extraActions,
  contentLabel
}: Props): ReactElement {
  const id = useId();
  return (
    <Dialog
      open={open}
      onClose={closeDisabled ? undefined : onClose}
      aria-labelledby={`${id}-title`}
      aria-describedby={description ? `${id}-description` : undefined}
      maxWidth="sm"
      fullWidth
    >
      <DialogTitle id={`${id}-title`}>{title}</DialogTitle>
      <DialogContent
        {...(contentLabel ? { role: 'region', 'aria-label': contentLabel, tabIndex: 0 } : {})}
        sx={contentLabel ? { '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } } : undefined}
      >
        {description ? <DialogContentText id={`${id}-description`}>{description}</DialogContentText> : null}
        {children}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <ActionButton
          startIcon={<CancelOutlinedIcon />}
          autoFocus={cancelAutoFocus}
          disabled={cancelDisabled}
          disabledReason={cancelDisabledReason}
          onClick={onClose}
        >
          {cancelLabel}
        </ActionButton>
        {extraActions}
        {confirmAgent ? (
          <AgentButton
            {...confirmAgent}
            color={confirmColor}
            variant="contained"
            disabled={confirmDisabled}
            disabledReason={confirmDisabledReason}
            onClick={onConfirm}
          >
            {confirmLabel}
          </AgentButton>
        ) : (
          <ActionButton
            startIcon={confirmIcon}
            color={confirmColor}
            variant="contained"
            disabled={confirmDisabled}
            disabledReason={confirmDisabledReason}
            onClick={onConfirm}
          >
            {confirmLabel}
          </ActionButton>
        )}
      </DialogActions>
    </Dialog>
  );
}
