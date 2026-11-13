/**
 * Способ генерации видео попытки: «Провайдер проекта» — запрос и платная отправка приложением, «Вручную вне приложения» —
 * пакет из утверждённых опор и видеопромпта, видео пользователь создаёт сам и загружает в попытку. Выбор записывает Go в попытку;
 * он делается до утверждения видеопромпта, потому что от способа зависят предел длины промпта и обозначения входов.
 */
import type { ReactElement } from 'react';
import { FormControl, FormControlLabel, FormHelperText, FormLabel, Radio, RadioGroup, Tooltip, Typography } from '@mui/material';
import type { ProductionGenerationMethod } from '@shared/production-workflow';
import { productionTexts } from '@shared/texts/production';

const texts = productionTexts.generationMethod;

export function GenerationMethodChoice({
  method,
  disabledReason,
  onChange
}: {
  method: ProductionGenerationMethod;
  /** Почему способ сейчас сменить нельзя; null — можно. */
  disabledReason: string | null | undefined;
  onChange(method: ProductionGenerationMethod): void;
}): ReactElement {
  const disabled = !!disabledReason;
  const option = (value: ProductionGenerationMethod, label: string, hint: string): ReactElement => (
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
    <Tooltip title={disabledReason ?? ''} placement="top-start">
      <FormControl component="fieldset">
        <FormLabel component="legend">{texts.heading}</FormLabel>
        <RadioGroup value={method} onChange={(event) => onChange(event.target.value as ProductionGenerationMethod)}>
          {option('provider', texts.provider, texts.providerHint)}
          {option('manual', texts.manual, texts.manualHint)}
        </RadioGroup>
        <FormHelperText>{disabledReason ?? texts.hint}</FormHelperText>
      </FormControl>
    </Tooltip>
  );
}
