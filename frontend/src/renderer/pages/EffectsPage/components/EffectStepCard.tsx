/**
 * Эффект цепочки плана: описание «когда и зачем», ползунки параметров по схеме из реестра Go с
 * подсказкой у названия (наведение или фокус), сброс к значениям по умолчанию и удаление из плана. У дождя — ветер: с ним наклон считает Go из ветра и камеры
 * плана, поэтому ползунок наклона скрыт; без ветра наклон задаётся ползунком.
 */
import { useId, type ReactElement } from 'react';
import { Alert, Box, Chip, FormControlLabel, IconButton, Paper, Slider, Stack, Switch, Tooltip, Typography } from '@mui/material';
import { visuallyHidden } from '@mui/utils';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import type { EffectParamSpec } from '@shared/types';
import { stepValue, withValue, type EffectKind, type EffectStep } from '@shared/effects';
import { effectsTexts as texts } from '@shared/texts/effects';
import { WindCompass } from './WindCompass';

/** Ветер по умолчанию при включении: на восток, умеренный. */
const DEFAULT_WIND = { direction: 0, strength: 0.4 };

function ParamSlider({
  spec,
  value,
  disabled,
  onChange
}: {
  spec: EffectParamSpec;
  value: number;
  disabled?: boolean;
  onChange(value: number): void;
}): ReactElement {
  const changed = value !== spec.default;
  const id = useId();
  return (
    <Box sx={{ minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', justifyContent: 'space-between' }}>
        <Tooltip title={spec.hint} placement="top-start" describeChild>
          <Stack
            direction="row"
            spacing={0.5}
            tabIndex={0}
            sx={{ alignItems: 'center', minWidth: 0, cursor: 'help', borderRadius: 0.5, '&:focus-visible': { outline: 2, outlineColor: 'primary.main' } }}
          >
            <Typography variant="body2" id={id} sx={{ overflowWrap: 'anywhere' }}>
              {spec.title}
            </Typography>
            <InfoOutlinedIcon color="action" sx={{ fontSize: 16, flex: '0 0 auto' }} aria-hidden />
          </Stack>
        </Tooltip>
        <Typography variant="body2" color={changed ? 'primary' : 'text.secondary'} sx={{ fontVariantNumeric: 'tabular-nums', flex: '0 0 auto' }}>
          {value}
        </Typography>
      </Stack>
      <Slider
        size="small"
        min={spec.min}
        max={spec.max}
        step={spec.step}
        value={value}
        disabled={disabled}
        aria-labelledby={id}
        slotProps={{ input: { 'aria-describedby': `${id}-hint` } }}
        valueLabelDisplay="auto"
        onChange={(_, next) => onChange(Array.isArray(next) ? next[0] : next)}
      />
      <Box component="span" id={`${id}-hint`} sx={visuallyHidden}>
        {spec.hint}
      </Box>
    </Box>
  );
}

export function EffectStepCard({
  kind,
  step,
  camera,
  heading,
  disabled,
  onChange,
  onRemove
}: {
  kind: EffectKind;
  step: EffectStep;
  /** У плана есть направление камеры: ветер применим. */
  camera: boolean;
  heading: number;
  disabled?: boolean;
  onChange(step: EffectStep): void;
  onRemove(): void;
}): ReactElement {
  const windy = !!kind.windAngle && !!step.wind;
  const specs = kind.params.filter((spec) => !(windy && spec.name === kind.windAngle));
  const changed = Object.keys(step.given).length + (step.wind ? 1 : 0);
  return (
    <Paper variant="outlined" sx={{ p: 2, minWidth: 0 }}>
      <Stack direction="row" spacing={1} sx={{ alignItems: 'center', mb: 1 }}>
        <Typography variant="subtitle1" sx={{ flex: 1, minWidth: 0 }}>
          {kind.title}
        </Typography>
        {changed ? <Chip size="small" label={texts.changed({ count: changed })} /> : null}
        <Tooltip title={texts.resetStepHint}>
          <span>
            <IconButton
              size="small"
              aria-label={texts.resetStepHint}
              disabled={disabled || !changed}
              onClick={() => onChange({ effect: step.effect, given: {} })}
            >
              <RestartAltIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
        <Tooltip title={texts.removeStep({ title: kind.title })}>
          <span>
            <IconButton size="small" aria-label={texts.removeStep({ title: kind.title })} disabled={disabled} onClick={onRemove}>
              <DeleteOutlineIcon fontSize="small" />
            </IconButton>
          </span>
        </Tooltip>
      </Stack>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 2 }}>
        {kind.hint}
      </Typography>
      {kind.windAngle ? (
        <Box sx={{ mb: 2 }}>
          <FormControlLabel
            control={
              <Switch
                checked={windy}
                disabled={disabled || (!camera && !windy)}
                onChange={(event) => {
                  if (event.target.checked) {
                    const given = { ...step.given };
                    delete given[kind.windAngle];
                    onChange({ ...step, given, wind: { ...DEFAULT_WIND } });
                  } else onChange({ effect: step.effect, given: step.given });
                }}
              />
            }
            label={texts.wind.toggle}
          />
          {!camera ? (
            <Alert severity="info" sx={{ mt: 1 }}>
              {texts.wind.noCamera}
            </Alert>
          ) : (
            <Typography variant="body2" color="text.secondary">
              {texts.wind.hint}
            </Typography>
          )}
          {windy && step.wind ? (
            <Stack direction="row" spacing={2} useFlexGap sx={{ mt: 1.5, alignItems: 'center', flexWrap: 'wrap' }}>
              <WindCompass
                direction={step.wind.direction}
                heading={camera ? heading : null}
                disabled={disabled}
                onChange={(direction) => step.wind && onChange({ ...step, wind: { ...step.wind, direction } })}
              />
              <Stack spacing={1} sx={{ flex: '1 1 220px', minWidth: 0 }}>
                <ParamSlider
                  spec={{
                    name: 'wind-direction',
                    title: texts.wind.direction,
                    min: 0,
                    max: 359,
                    default: DEFAULT_WIND.direction,
                    step: 1,
                    hint: texts.wind.directionHint
                  }}
                  value={step.wind.direction}
                  disabled={disabled}
                  onChange={(direction) => step.wind && onChange({ ...step, wind: { ...step.wind, direction } })}
                />
                <ParamSlider
                  spec={{
                    name: 'wind-strength',
                    title: texts.wind.strength,
                    min: 0,
                    max: 3,
                    default: DEFAULT_WIND.strength,
                    step: 0.05,
                    hint: texts.wind.strengthHint
                  }}
                  value={step.wind.strength}
                  disabled={disabled}
                  onChange={(strength) => step.wind && onChange({ ...step, wind: { ...step.wind, strength } })}
                />
                <Typography variant="body2" color="text.secondary">
                  {texts.wind.fromWind}
                </Typography>
              </Stack>
            </Stack>
          ) : null}
        </Box>
      ) : null}
      <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', columnGap: 3, rowGap: 0.5 }}>
        {specs.map((spec) => (
          <ParamSlider
            key={spec.name}
            spec={spec}
            value={stepValue(step, spec)}
            disabled={disabled}
            onChange={(value) => onChange(withValue(step, spec, value))}
          />
        ))}
      </Box>
    </Paper>
  );
}
