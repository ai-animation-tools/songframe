/**
 * Способ новой попытки перед описанием: «По опорам» — опоры Codex и точные первый и последний кадры, «По референсам» —
 * видео по картинкам места и героев без опор. Выбор уходит в запуск описания (productionWorkflow.start, method) и после
 * него остаётся способом попытки, поэтому делается до описания.
 */
import type { ReactElement } from 'react';
import { FormControl, FormControlLabel, FormLabel, Radio, RadioGroup, Typography } from '@mui/material';
import { productionTexts } from '@shared/texts/production';

const texts = productionTexts.referencesMethod;

export type AttemptMethod = 'references' | 'keyframes';

export function ReferencesMethodChoice({
  method,
  disabled,
  onChange
}: {
  method: AttemptMethod;
  disabled: boolean;
  onChange(method: AttemptMethod): void;
}): ReactElement {
  const option = (value: AttemptMethod, label: string, hint: string): ReactElement => (
    <FormControlLabel
      value={value}
      disabled={disabled}
      control={<Radio size="small" />}
      label={
        <span>
          <Typography variant="body2" component="span">
            {label}
          </Typography>
          <Typography variant="caption" color="text.secondary" component="span" sx={{ display: 'block' }}>
            {hint}
          </Typography>
        </span>
      }
    />
  );
  return (
    <FormControl component="fieldset">
      <FormLabel component="legend">{texts.heading}</FormLabel>
      <RadioGroup value={method} onChange={(event) => onChange(event.target.value as AttemptMethod)}>
        {option('keyframes', texts.keyframes, texts.keyframesHint)}
        {option('references', texts.references, texts.referencesHint)}
      </RadioGroup>
    </FormControl>
  );
}
