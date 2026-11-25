/**
 * Эффект цепочки плана — сворачиваемая панель (Accordion): свёрнутый эффект не мешает настраивать
 * соседний, в заголовке видно, сколько параметров изменено. Внутри — описание «когда и зачем»,
 * числовые поля параметров по схеме из реестра Go с подсказкой, диапазоном и значением по умолчанию,
 * а после них действия: сброс к значениям по умолчанию и удаление из плана. У дождя — ветер: с ним
 * наклон считает Go из ветра и камеры плана, поэтому поле наклона скрыто; без ветра наклон
 * задаётся полем. У эффекта без параметров («Реверс») нет полей и сброса — только описание и удаление.
 * Моменты плана (planTime реестра) собраны в блок «Время»: поля в секундах плана, рецепт хранит
 * доли; отметки моментов и строки песни — на общей шкале под превью страницы. Источник и луч (beam
 * реестра) ставятся ручками на общем превью: здесь их поля и переключатель ручек.
 */
import type { ReactElement } from 'react';
import {
  Accordion,
  AccordionDetails,
  AccordionSummary,
  Alert,
  Box,
  Chip,
  FormControlLabel,
  IconButton,
  Stack,
  Switch,
  Tooltip,
  Typography
} from '@mui/material';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import RestartAltIcon from '@mui/icons-material/RestartAlt';
import MyLocationIcon from '@mui/icons-material/MyLocation';
import type { EffectParamSpec } from '@shared/types';
import {
  fractionToSeconds,
  planSeconds,
  roundToStep,
  secondsToFraction,
  stepValue,
  withValue,
  type EffectKind,
  type EffectShot,
  type EffectStep
} from '@shared/effects';
import { effectsTexts as texts } from '@shared/texts/effects';
import { ActionButton } from '../../../components/ActionButton';
import { NumberField } from '../../../components/NumberField';
import { WindCompass } from './WindCompass';
import { formatSeconds } from './PlanTimeline';

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

/** Сетка полей параметров. */
const FIELDS = { display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(260px, 1fr))', gap: 1.5 } as const;

/** План, на кадре и времени которого настраивается эффект: кадр превью и ручки на общем превью. */
export interface EffectPlanContext {
  shot: Pick<EffectShot, 'frames' | 'fps'>;
  /** Номер кадра превью. */
  frame: number;
  /** Ручки источника и луча показаны на общем превью. */
  handles: boolean;
  onHandles(shown: boolean): void;
}

/**
 * Момент плана — поле в секундах: рецепт хранит долю длины плана, поле показывает и принимает
 * секунды. Кнопка рядом ставит время кадра превью.
 */
function PlanTimeField({
  spec,
  step,
  plan,
  disabled,
  onChange
}: {
  spec: EffectParamSpec;
  step: EffectStep;
  plan: EffectPlanContext;
  disabled?: boolean;
  onChange(step: EffectStep): void;
}): ReactElement {
  const duration = planSeconds(plan.shot);
  const title = texts.time.title({ title: spec.title });
  const set = (seconds: number): void => onChange(withValue(step, spec, secondsToFraction(seconds, plan.shot)));
  return (
    <Stack direction="row" spacing={0.5} sx={{ alignItems: 'flex-start' }}>
      <NumberField
        label={title}
        value={fractionToSeconds(stepValue(step, spec), plan.shot)}
        min={0}
        max={Math.round(duration * 100) / 100}
        step={0.1}
        disabled={disabled}
        helperText={texts.time.helper({
          hint: spec.hint,
          max: formatSeconds(duration),
          value: formatSeconds(fractionToSeconds(spec.default, plan.shot))
        })}
        onChange={(next) => next !== undefined && set(next)}
      />
      <Tooltip title={texts.time.toFrame({ title: spec.title })}>
        <span>
          <IconButton aria-label={texts.time.toFrame({ title: spec.title })} disabled={disabled} onClick={() => set(plan.frame / plan.shot.fps)}>
            <MyLocationIcon />
          </IconButton>
        </span>
      </Tooltip>
    </Stack>
  );
}

export function EffectStepCard({
  kind,
  step,
  camera,
  heading,
  plan,
  disabled,
  onChange,
  onRemove
}: {
  kind: EffectKind;
  step: EffectStep;
  /** У плана есть направление камеры: ветер применим. */
  camera: boolean;
  heading: number;
  /** План с кадром превью: без него моменты и луч задаются обычными полями. */
  plan?: EffectPlanContext;
  disabled?: boolean;
  onChange(step: EffectStep): void;
  onRemove(): void;
}): ReactElement {
  const windy = !!kind.windAngle && !!step.wind;
  const beam = plan ? kind.beam : null;
  const beamNames = beam ? [beam.x, beam.y, beam.direction, beam.cone, beam.radius] : [];
  const timeNames = plan ? kind.planTime : [];
  const field = (spec: EffectParamSpec): ReactElement => (
    <ParamField key={spec.name} spec={spec} value={stepValue(step, spec)} disabled={disabled} onChange={(value) => onChange(withValue(step, spec, value))} />
  );
  const beamSpecs = kind.params.filter((spec) => beamNames.includes(spec.name));
  const timeSpecs = kind.params.filter((spec) => timeNames.includes(spec.name));
  const specs = kind.params.filter((spec) => !(windy && spec.name === kind.windAngle) && !beamNames.includes(spec.name) && !timeNames.includes(spec.name));
  const changed = Object.keys(step.given).length + (step.wind ? 1 : 0);
  const configurable = kind.params.length > 0 || !!kind.windAngle;
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
        {beam && plan && beamSpecs.length ? (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2">{texts.beam.heading}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {texts.beam.hint}
            </Typography>
            <FormControlLabel
              control={<Switch checked={plan.handles} onChange={(event) => plan.onHandles(event.target.checked)} />}
              label={texts.beam.toggle({ title: kind.title })}
              title={texts.beam.toggleHint}
            />
            <Box sx={{ ...FIELDS, mt: 1.5 }}>{beamSpecs.map(field)}</Box>
          </Box>
        ) : null}
        {plan && timeSpecs.length ? (
          <Box sx={{ mb: 2 }}>
            <Typography variant="subtitle2">{texts.time.heading}</Typography>
            <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
              {texts.time.hint}
            </Typography>
            <Box sx={FIELDS}>
              {timeSpecs.map((spec) => (
                <PlanTimeField key={spec.name} spec={spec} step={step} plan={plan} disabled={disabled} onChange={onChange} />
              ))}
            </Box>
          </Box>
        ) : null}
        {specs.length ? <Box sx={FIELDS}>{specs.map(field)}</Box> : null}
        <Stack direction="row" spacing={1} useFlexGap sx={{ flexWrap: 'wrap', mt: specs.length ? 2 : 0 }}>
          {configurable ? (
            <ActionButton
              startIcon={<RestartAltIcon />}
              title={texts.resetStepHint}
              disabled={disabled || !changed}
              disabledReason={disabled ? texts.busy : texts.noChanges}
              onClick={() => onChange({ effect: step.effect, given: {} })}
            >
              {texts.resetStep}
            </ActionButton>
          ) : null}
          <ActionButton startIcon={<DeleteOutlineIcon />} disabled={disabled} disabledReason={texts.busy} onClick={onRemove}>
            {texts.removeStep({ title: kind.title })}
          </ActionButton>
        </Stack>
      </AccordionDetails>
    </Accordion>
  );
}
