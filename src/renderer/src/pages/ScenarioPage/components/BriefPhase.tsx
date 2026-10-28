import { useState, type ReactElement } from 'react';
import { Box, Checkbox, FormControlLabel, FormGroup, Typography } from '@mui/material';
import type { BriefResult } from '@shared/types';
import { Prose } from '../../../components/Prose';

/** Отметки помогают сравнить кадр с ожидаемым состоянием и живут только в этом представлении. */
export function BriefPhase({ brief }: { brief: BriefResult }): ReactElement {
  const [checked, setChecked] = useState<Set<number>>(() => new Set());
  // Текст CLI содержит Markdown-список; в приложении вопросы берём из структурированного checklist.
  const description = brief.text.split('\n\nПроверить по кадру:')[0];
  const [heading, ...body] = description.split('\n');

  return (
    <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>
      <Typography variant="subtitle2" sx={{ mb: 1 }}>
        {heading}
      </Typography>
      <Prose text={body.join('\n').trim()} />
      {brief.checklist.length ? (
        <Box sx={{ mt: 2, minWidth: 0 }}>
          <Typography variant="subtitle2">Проверить по кадру:</Typography>
          <FormGroup>
            {brief.checklist.map((question, index) => (
              <FormControlLabel
                key={index}
                sx={{
                  m: 0,
                  alignItems: 'flex-start',
                  minWidth: 0,
                  '& .MuiFormControlLabel-label': { pt: 1, minWidth: 0, typography: 'body2', overflowWrap: 'anywhere' }
                }}
                control={
                  <Checkbox
                    checked={checked.has(index)}
                    onChange={(_, nextChecked) => {
                      setChecked((previous) => {
                        const next = new Set(previous);
                        if (nextChecked) next.add(index);
                        else next.delete(index);
                        return next;
                      });
                    }}
                  />
                }
                label={question}
              />
            ))}
          </FormGroup>
        </Box>
      ) : null}
    </Box>
  );
}
