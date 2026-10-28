import { Close, FileDownload } from '@mui/icons-material';
import { useState, type ReactElement } from 'react';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import { ActionButton } from '../../../components/ActionButton';

/** Готовая проба открывается из панели действий: под дорожкой результат уходил за пределы окна. */
export function MontageExportDialog({
  open,
  url,
  busy,
  onClose,
  onSave
}: {
  open: boolean;
  url: string;
  busy: boolean;
  onClose: () => void;
  onSave: () => void;
}): ReactElement {
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  return (
    <Dialog open={open} onClose={onClose} maxWidth="lg" fullWidth>
      <DialogTitle>Готовая проба MP4</DialogTitle>
      <DialogContent>
        {failedUrl === url ? (
          <Alert severity="error" sx={{ mb: 1 }}>
            Не удалось воспроизвести готовую пробу. Проверьте, что файл доступен в папке проекта.
          </Alert>
        ) : null}
        {open ? (
          <Box
            component="video"
            src={url}
            controls
            preload="metadata"
            aria-label="Готовая проба MP4"
            onError={() => setFailedUrl(url)}
            sx={{ display: 'block', width: '100%', maxHeight: '65vh', bgcolor: '#000' }}
          />
        ) : null}
        <Typography variant="caption" color="text.secondary" display="block" sx={{ mt: 1 }}>
          Экспорт содержит состояние монтажа на момент запуска задания.
        </Typography>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button startIcon={<Close />} onClick={onClose}>
          Закрыть
        </Button>
        <Box sx={{ flex: 1 }} />
        <ActionButton variant="contained" startIcon={<FileDownload />} disabled={busy} disabledReason="Дождитесь завершения текущей операции." onClick={onSave}>
          Сохранить MP4 как
        </ActionButton>
      </DialogActions>
    </Dialog>
  );
}
