import { useState, type ReactElement, type ReactNode } from 'react';
import { Box, Button, IconButton, Tooltip, type SxProps, type Theme } from '@mui/material';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import { ConfirmationDialog } from './ConfirmationDialog';

interface Props {
  label: string;
  description: string;
  onConfirm(): void;
  children?: ReactNode;
  icon?: boolean;
  disabled?: boolean;
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
  size = 'small',
  sx,
  confirmLabel = 'Удалить',
  startIcon,
  variant = 'text'
}: Props): ReactElement {
  const [open, setOpen] = useState(false);
  return (
    <>
      {icon ? (
        <Tooltip title={label}>
          <Box component="span" sx={[{ display: 'inline-flex', borderRadius: '50%' }, ...(sx ? (Array.isArray(sx) ? sx : [sx]) : [])]}>
            <IconButton color="error" aria-label={label} size={size} disabled={disabled} onClick={() => setOpen(true)}>
              {children}
            </IconButton>
          </Box>
        </Tooltip>
      ) : (
        <Button
          color="error"
          variant={variant}
          startIcon={startIcon ?? <WarningAmberIcon />}
          size={size}
          disabled={disabled}
          sx={sx}
          onClick={() => setOpen(true)}
        >
          {children ?? label}
        </Button>
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
        confirmIcon={startIcon ?? (confirmLabel === 'Удалить' ? <DeleteOutlineIcon /> : <WarningAmberIcon />)}
        confirmColor="error"
        confirmDisabled={disabled}
        cancelAutoFocus
      />
    </>
  );
}
