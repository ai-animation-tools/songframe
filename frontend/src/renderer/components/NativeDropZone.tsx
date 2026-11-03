import { Box, Stack, Typography } from '@mui/material';
import UploadFileIcon from '@mui/icons-material/UploadFile';

/** Drop активирует Wails через data-file-drop-target; браузерный File не выдаётся за настоящий путь ОС. */
export function NativeDropZone({
  id,
  title,
  hint,
  onPick,
  disabled = false
}: {
  id: string;
  title: string;
  hint: string;
  onPick: () => void;
  disabled?: boolean;
}) {
  return (
    <Box
      id={id}
      data-file-drop-target
      role="button"
      tabIndex={disabled ? -1 : 0}
      aria-label={title}
      aria-disabled={disabled}
      onClick={() => {
        if (!disabled) onPick();
      }}
      onKeyDown={(event) => {
        if (!disabled && (event.key === 'Enter' || event.key === ' ')) {
          event.preventDefault();
          onPick();
        }
      }}
      sx={{
        minHeight: 160,
        p: 2,
        display: 'grid',
        placeItems: 'center',
        border: 1,
        borderStyle: 'dashed',
        borderColor: 'divider',
        borderRadius: 1,
        cursor: disabled ? 'default' : 'pointer',
        '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 }
      }}
    >
      <Stack alignItems="center" spacing={1} sx={{ pointerEvents: 'none' }}>
        <UploadFileIcon color="action" />
        <Typography align="center">{title}</Typography>
        <Typography align="center" variant="body2" color="text.secondary">
          {hint}
        </Typography>
      </Stack>
    </Box>
  );
}
