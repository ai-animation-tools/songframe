import { useId, type ReactElement, type ReactNode } from 'react';
import { Button, Dialog, DialogActions, DialogContent, DialogContentText, DialogTitle } from '@mui/material';
import CancelOutlinedIcon from '@mui/icons-material/CancelOutlined';
import type { AgentProvider } from '@shared/agent-providers';
import type { AiActionKind } from '@shared/ai-access';
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
  confirmAgent?: { provider?: AgentProvider; aiKind?: AiActionKind; external?: boolean };
  confirmColor?: 'primary' | 'error' | 'warning';
  confirmDisabled?: boolean;
  cancelDisabled?: boolean;
  closeDisabled?: boolean;
  cancelLabel?: string;
  cancelAutoFocus?: boolean;
  extraActions?: ReactNode;
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
  cancelDisabled = false,
  closeDisabled = false,
  cancelLabel = 'Отмена',
  cancelAutoFocus = false,
  extraActions
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
      <DialogContent>
        {description ? <DialogContentText id={`${id}-description`}>{description}</DialogContentText> : null}
        {children}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap' }}>
        <Button startIcon={<CancelOutlinedIcon />} autoFocus={cancelAutoFocus} disabled={cancelDisabled} onClick={onClose}>
          {cancelLabel}
        </Button>
        {extraActions}
        {confirmAgent ? (
          <AgentButton {...confirmAgent} color={confirmColor} variant="contained" disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </AgentButton>
        ) : (
          <Button startIcon={confirmIcon} color={confirmColor} variant="contained" disabled={confirmDisabled} onClick={onConfirm}>
            {confirmLabel}
          </Button>
        )}
      </DialogActions>
    </Dialog>
  );
}
