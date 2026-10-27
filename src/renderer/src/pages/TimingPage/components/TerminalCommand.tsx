/** Команда для терминала с копированием точного текста без выделения мышью. */
import type { ReactElement } from 'react';
import { Box, Button, Stack } from '@mui/material';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import { useApp } from '../../../state';

export function TerminalCommand({ command }: { command: string }): ReactElement {
  const { notify, describeError } = useApp();
  const copy = async (): Promise<void> => {
    try {
      await navigator.clipboard.writeText(command);
      notify('Команда скопирована', 'success');
    } catch (error) {
      notify(describeError(error), 'error');
    }
  };

  return (
    <Stack alignItems="flex-start" sx={{ bgcolor: 'action.hover' }}>
      <Box component="pre" sx={{ m: 0, p: 1, flex: 1, minWidth: 0, whiteSpace: 'pre-wrap', overflowWrap: 'anywhere', fontSize: 12, userSelect: 'text' }}>
        {command}
      </Box>
      <Button size="small" startIcon={<ContentCopyIcon />} onClick={copy} sx={{ m: 0.5 }}>
        Копировать команду
      </Button>
    </Stack>
  );
}
