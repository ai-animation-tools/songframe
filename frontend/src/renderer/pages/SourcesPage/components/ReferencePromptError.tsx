import { sourcesTexts } from '@shared/texts/sources';
import type { ReactElement } from 'react';
import RefreshIcon from '@mui/icons-material/Refresh';
import { Alert, Box, Button } from '@mui/material';

interface Props {
  error: { path: string; message: string };
  onRetry: () => Promise<void>;
}

/** Ошибка чтения относится к своему промпту и не скрывает остальные изображения и введённый текст. */
export function ReferencePromptError({ error, onRetry }: Props): ReactElement {
  return (
    <Alert
      severity="warning"
      action={
        <Button startIcon={<RefreshIcon />} onClick={onRetry}>
          {sourcesTexts.retryRead}
        </Button>
      }
    >
      {sourcesTexts.promptReadError({ path: error.path })}
      <Box component="details" sx={{ mt: 0.5 }}>
        <Box component="summary" sx={{ cursor: 'pointer' }}>
          {sourcesTexts.errorDetails}
        </Box>
        {error.message}
      </Box>
    </Alert>
  );
}
