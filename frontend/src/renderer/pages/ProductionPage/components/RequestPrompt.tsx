import { productionTexts } from '@shared/texts/production';
import { savedLooksTexts } from '@shared/texts/saved-looks';
import type { SavedLookUse } from '@shared/saved-looks';
import { useId, type ReactElement } from 'react';
import { Alert, Box, Paper, Typography } from '@mui/material';
import { Prose } from '../../../components/Prose';

/**
 * Показываем сохранённый текст без правок: перенос меняет только отображение подтверждаемого запроса. У запроса с
 * сохранёнными образами под текстом — какой образ аккаунта уходит у какого героя (часть того же SHA); если модель
 * запроса образы не принимает, а в видеопромпте были метки, — предупреждение, кто потеряет облик.
 */
export function RequestPrompt({ text, looks, lostLooks }: { text: string; looks?: SavedLookUse[]; lostLooks?: string[] }): ReactElement {
  const labelId = useId();
  const looksId = useId();
  return (
    <Paper component="section" variant="outlined" aria-labelledby={labelId} sx={{ p: 2, minWidth: 0, bgcolor: 'action.hover' }}>
      <Typography id={labelId} component="h3" variant="subtitle2" sx={{ mb: 1 }}>
        {productionTexts.requestPrompt.heading}
      </Typography>
      <Box
        tabIndex={0}
        aria-labelledby={labelId}
        sx={{ maxHeight: 240, overflowY: 'auto', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 4 } }}
      >
        <Prose text={text} />
      </Box>
      {looks?.length ? (
        <Box sx={{ mt: 1.5 }}>
          <Typography id={looksId} component="h4" variant="subtitle2">
            {savedLooksTexts.requestLooks}
          </Typography>
          <Box component="ul" aria-labelledby={looksId} sx={{ m: 0, pl: 2.5 }}>
            {looks.map((look) => (
              <Typography key={look.code} component="li" variant="body2">
                {savedLooksTexts.requestLook({ entity: look.entity, name: look.name })}
              </Typography>
            ))}
          </Box>
        </Box>
      ) : null}
      {lostLooks?.length ? (
        <Alert severity="warning" sx={{ mt: 1.5 }}>
          {savedLooksTexts.lostLooks({ entities: lostLooks.join(', ') })}
        </Alert>
      ) : null}
    </Paper>
  );
}
