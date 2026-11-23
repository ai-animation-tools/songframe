/**
 * Эффект цепочки плана — сворачиваемая панель (Accordion): свёрнутый эффект не мешает настраивать
 * соседний, в заголовке видно, сколько параметров изменено. Внутри — описание «когда и зачем»,
 * числовые поля параметров по схеме из реестра Go с подсказкой, диапазоном и значением по умолчанию,
 * а после них действия: сброс к значениям по умолчанию и удаление из плана. У дождя — ветер: с ним
 * наклон считает Go из ветра и камеры плана, поэтому поле наклона скрыто; без ветра наклон
 * задаётся полем.
 */
import type { ReactElement } from 'react';
import { Accordion, AccordionDetails, AccordionSummary, Alert, Box, Chip, FormControlLabel, Stack, Switch, Typography } from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import type { EffectParamSpec } from '@shared/types';
import { roundToStep, stepValue, withValue, type EffectKind, type EffectStep } from '@shared/effects';
import { effectsTexts as texts } from '@shared/texts/effects';
import { ActionButton } from '../../../components/ActionButton';
import { NumberField } from '../../../components/NumberField';
import { WindCompass } from './WindCompass';

/** Ветер по умолчанию при включении: на восток, умеренный. */
const DEFAULT_WIND = { direction: 0, strength: 0.4 };

/**
 * Параметр эффекта — числовое поле: значение вписывается точно, стрелки поля меняют его на шаг.
 * Под полем — подсказка реестра, допустимый диапазон и значение по умолчанию. Число вне диапазона
 * поле подсвечивает и в черновик не отдаёт; принятое значение округляется до точности шага.
 */
function ParamField({
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
  return (
    <NumberField
      label={spec.title}
      value={value}
      min={spec.min}
      max={spec.max}
      step={spec.step}
      disabled={disabled}
      helperText={texts.paramHelper({ hint: spec.hint, min: spec.min, max: spec.max, value: spec.default })}
      onChange={(next) => next !== undefined && onChange(roundToStep(next, spec.step))}
    />
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
    <Accordion variant="outlined" disableGutters defaultExpanded sx={{ minWidth: 0 }}>
      <AccordionSummary expandIcon={<ExpandMoreIcon />}>
        <Stack direction="row" spacing={1} useFlexGap sx={{ alignItems: 'center', flexWrap: 'wrap', minWidth: 0 }}>
          <Typography variant="subtitle1">{kind.title}</Typography>
          {changed ? <Chip size="small" label={texts.changed({ count: changed })} /> : null}
        </Stack>
      </AccordionSummary>
      <AccordionDetails>
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
                  <ParamField
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
                  <ParamField
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
        <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 1.5 }}>
          {specs.map((spec) => (
            <ParamField
              key={spec.name}
              spec={spec}
              value={stepValue(step, spec)}
              disabled={disabled}
              onChange={(value) => onChange(withValue(step, spec, value))}
            />
          ))}
        </Box>
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: 2 }}>
          <ActionButton
            startIcon={<RestartAltIcon />}
            title={texts.resetStepHint}
            disabled={disabled || !changed}
            disabledReason={disabled ? texts.busy : texts.noChanges}
            onClick={() => onChange({ effect: step.effect, given: {} })}
          >
            {texts.resetStep}
          </ActionButton>
          <ActionButton startIcon={<DeleteOutlineIcon />} disabled={disabled} disabledReason={texts.busy} onClick={onRemove}>
            {texts.removeStep({ title: kind.title })}
          </ActionButton>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
