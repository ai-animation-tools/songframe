import { useId, type ReactElement } from 'react';
import { Box, Paper, Typography } from '@mui/material';
import { Prose } from '../../../components/Prose';

/** Показываем сохранённый текст без правок: перенос меняет только отображение подтверждаемого запроса. */
export function RequestPrompt({ text }: { text: string }): ReactElement {
  const labelId = useId();
  return (
    <Paper component="section" variant="outlined" aria-labelledby={labelId} sx={{ p: 2, minWidth: 0, bgcolor: 'action.hover' }}>
      <Typography id={labelId} component="h3" variant="subtitle2" sx={{ mb: 1 }}>
        Промпт запроса
      </Typography>
      <Box
        tabIndex={0}
        aria-labelledby={labelId}
        sx={{ maxHeight: 240, overflowY: 'auto', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 4 } }}
      >
        <Prose text={text} />
      </Box>
    </Paper>
  );
}
