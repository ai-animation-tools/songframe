import { commonTexts } from '@shared/texts/common';
import { useState, type ReactElement, type ReactNode } from 'react';
import { Box, type SxProps, type Theme } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { ActionButton } from './ActionButton';
import { ActionIconButton } from './ActionIconButton';
import { ConfirmationDialog } from './ConfirmationDialog';

interface Props {
  label: string;
  description: string;
  onConfirm(): void;
  children?: ReactNode;
  icon?: boolean;
  disabled?: boolean;
  /** Что мешает действию и что сделать; видно в подсказке выключенной кнопки. */
  disabledReason?: string | null;
  size?: 'small' | 'medium' | 'large';
  sx?: SxProps<Theme>;
  confirmLabel?: string;
  startIcon?: ReactNode;
  variant?: 'text' | 'outlined' | 'contained';
}

/** Удаление выполняется только после явного подтверждения; Escape и закрытие диалога сохраняют данные. */
export function DestructiveButton({
  label,
  description,
  onConfirm,
  children,
  icon = false,
  disabled,
  disabledReason,
  size = 'small',
  sx,
  confirmLabel = commonTexts.delete,
  startIcon,
  variant = 'text'
}: Props): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      {icon ? (
        <Box component="span" sx={[{ display: 'inline-flex', borderRadius: '50%' }, ...(sx ? (Array.isArray(sx) ? sx : [sx]) : [])]}>
          <ActionIconButton color="error" aria-label={label} size={size} disabled={disabled} disabledReason={disabledReason} onClick={() => setOpen(true)}>
            {children}
          </ActionIconButton>
        </Box>
      ) : (
        <ActionButton
          color="error"
          variant={variant}
          startIcon={startIcon ?? <WarningAmberIcon />}
          size={size}
          disabled={disabled}
          disabledReason={disabledReason}
          sx={sx}
          onClick={() => setOpen(true)}
        >
          {children ?? label}
        </ActionButton>
      )}
      <ConfirmationDialog
        open={open}
        title={`${label}?`}
        description={description}
        onClose={() => setOpen(false)}
        onConfirm={() => {
          setOpen(false);
          onConfirm();
        }}
        confirmLabel={confirmLabel}
        confirmIcon={startIcon ?? (confirmLabel === commonTexts.delete ? <DeleteOutlineIcon /> : <WarningAmberIcon />)}
        confirmColor="error"
        confirmDisabled={disabled}
        confirmDisabledReason={disabledReason}
        cancelAutoFocus
      />
    </>
  );
}
