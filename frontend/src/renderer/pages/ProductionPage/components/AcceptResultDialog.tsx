import { productionTexts } from '@shared/texts/production';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
import FitScreenIcon from '@mui/icons-material/FitScreen';
/**
 * Параметры переноса результата в assets с сохранением выбранного монтажного участка. У участка —
 * итог: сколько кадров получится в плане при скорости и удержании и совпадает ли это с окном плана
 * (счёт тот же, что у Go, — cutResultFrames), чтобы несовпадение было видно до «Принять».
 * «Подогнать конец под окно» подставляет конец, при котором план совпадёт с окном (fitCutEnd).
 * «Показать участок под песню» собирает участок так, как его примет приёмка (CutPreviewPanel).
 */
import type { ReactElement } from 'react';
import { Alert, Box, Checkbox, FormControlLabel, MenuItem, Stack, TextField } from '@mui/material';
import type { AcceptOptions, CutPreview } from '@shared/types';
import type { AcceptTarget } from '../decisions';
import { cutFrameOf, cutResultFrames, cutSeconds, DEFAULT_FPS, fitCutEnd } from '@shared/video';
import { ActionButton } from '../../../components/ActionButton';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';
import { CutPreviewPanel } from './CutPreviewPanel';

export function AcceptResultDialog({
  target,
  options,
  onOptions,
  onClose,
  onConfirm,
  onPreview,
  kind = 'accept'
}: {
  target: AcceptTarget | null;
  options: AcceptOptions;
  onOptions(value: AcceptOptions): void;
  onClose(): void;
  onConfirm(): void;
  /** Предпросмотр участка (production.cutPreview); без него кнопки предпросмотра нет. */
  onPreview?(options: AcceptOptions): Promise<CutPreview>;
  /** accept — приёмка результата попытки; recut — новый участок уже принятого плана из оригинала комплекта. */
  kind?: 'accept' | 'recut';
}): ReactElement {
  const recut = kind === 'recut';
  const durationMismatch = !!target?.windowFrames && !!target.originalFrames && target.windowFrames !== target.originalFrames;
  // Другой кадр или частота оригинала тоже закрывают «целиком»: видео приводится к кадру проекта участком.
  const frameMismatch = target?.frameMismatch;
  const mismatch = durationMismatch || !!frameMismatch;
  // Без открытого диалога (target null) шкала не используется; DEFAULT_FPS лишь держит расчёт определённым.
  const fps = target?.fps ?? DEFAULT_FPS;
  const seconds = (frames?: number): string => ((frames ?? 0) / fps).toFixed(2).replace('.', ',');
  // Граница участка вводится секундами до тысячных; стрелки поля шагают на кадр и тоже округляются.
  const thousandths = (value: string): number => Math.round(Number(value) * 1000) / 1000;
  // Подсказка под границей: кадр сетки проекта или соседние кадры, если граница между ними.
  const boundary = (value: number): { helperText: string; error: boolean } => {
    const frame = cutFrameOf(value, fps);
    if (frame !== null) return { helperText: productionTexts.acceptResultDialog.cutFrame({ frame }), error: false };
    const before = Math.max(0, Math.floor(value * fps));
    const text = (index: number): string => String(cutSeconds(index, fps)).replace('.', ',');
    return { helperText: productionTexts.acceptResultDialog.cutBetween({ before: text(before), after: text(before + 1) }), error: true };
  };
  // Итог участка, как его посчитает Go: сколько кадров получится в плане и совпадает ли с окном.
  const result = (): { severity: 'success' | 'warning' | 'info' | 'error'; text: string } => {
    const texts = productionTexts.acceptResultDialog;
    const frames = cutResultFrames(
      cutFrameOf(options.cutStart ?? 0, fps),
      cutFrameOf(options.cutEnd ?? 0, fps),
      options.speed ?? '1',
      options.holdFirst ?? 0,
      options.holdLast ?? 0
    );
    if (frames === null) return { severity: 'error', text: texts.cutResultInvalid };
    const length = { frames, seconds: seconds(frames) };
    const window = target?.windowFrames;
    if (!window) return { severity: 'info', text: texts.cutResultLength(length) };
    if (frames === window) return { severity: 'success', text: texts.cutResultFit(length) };
    return frames < window
      ? { severity: 'warning', text: texts.cutResultShort({ frames, window, missing: window - frames }) }
      : { severity: 'warning', text: texts.cutResultLong({ frames, window, extra: frames - window }) };
  };
  const cutResult = options.mode === 'cut' ? result() : null;
  // Конец участка под окно плана: новое значение поля или причина, почему его не подобрать.
  const fit = (): { end: number; reason: null } | { end: null; reason: string } => {
    const texts = productionTexts.acceptResultDialog;
    if (!target?.windowFrames) return { end: null, reason: texts.fitEndNoWindow };
    const fitted = fitCutEnd(
      cutFrameOf(options.cutStart ?? 0, fps),
      options.speed ?? '1',
      target.windowFrames,
      options.holdFirst ?? 0,
      options.holdLast ?? 0,
      target.originalFrames
    );
    if ('endFrame' in fitted) return { end: cutSeconds(fitted.endFrame, fps), reason: null };
    if (fitted.reason === 'holdsTooLong') return { end: null, reason: texts.fitEndHolds };
    if (fitted.reason === 'originalTooShort')
      return { end: null, reason: texts.fitEndOriginal({ needed: seconds(fitted.neededFrames), original: seconds(target.originalFrames) }) };
    return { end: null, reason: texts.fitEndInvalid };
  };
  const fitted = options.mode === 'cut' ? fit() : null;
  // Предпросмотр всегда собирается участком: «целиком» — это участок во всё окно со скоростью 1.
  const previewOptions: AcceptOptions =
    options.mode === 'cut'
      ? {
          mode: 'cut',
          cutStart: options.cutStart,
          cutEnd: options.cutEnd,
          speed: options.speed ?? '1',
          holdFirst: options.holdFirst ?? 0,
          holdLast: options.holdLast ?? 0
        }
      : { mode: 'cut', cutStart: 0, cutEnd: cutSeconds(target?.windowFrames ?? 0, fps), speed: '1', holdFirst: 0, holdLast: 0 };
  const previewReason =
    !target?.windowFrames || (options.mode === 'cut' && cutResult?.severity !== 'success') ? productionTexts.acceptResultDialog.previewMismatch : null;
  return (
    <ConfirmationDialog
      open={!!target}
      explicitCancelOnly
      onClose={onClose}
      title={(recut ? productionTexts.acceptResultDialog.recutTitle : productionTexts.acceptResultDialog.title)({ shot: target?.shot ?? '' })}
      onConfirm={onConfirm}
      confirmLabel={
        recut
          ? productionTexts.acceptResultDialog.recutConfirm
          : target?.hasAsset
            ? productionTexts.acceptResultDialog.replace
            : productionTexts.acceptResultDialog.accept
      }
      confirmIcon={<CheckCircleIcon />}
      confirmColor="error"
      // У нового участка принятого плана источник — сам комплект: токена результата и согласия на замену нет.
      confirmDisabled={!recut && (!target?.resultToken || !!target?.speechMissing || (!!target?.hasAsset && !options.replaceExisting))}
      confirmDisabledReason={
        !target?.resultToken
          ? productionTexts.acceptResultDialog.resultUnconfirmed
          : target.speechMissing
            ? productionTexts.acceptResultDialog.speechRequired
            : productionTexts.acceptResultDialog.replacementRequired
      }
    >
      <Stack spacing={2} sx={{ mt: 1 }}>
        {target?.hasAsset ? <Alert severity="warning">{productionTexts.acceptResultDialog.replacementDescription({ shot: target.shot })}</Alert> : null}
        {target?.hasAsset ? (
          <FormControlLabel
            control={<Checkbox checked={!!options.replaceExisting} onChange={(e) => onOptions({ ...options, replaceExisting: e.target.checked })} />}
            label={productionTexts.acceptResultDialog.replaceCheckbox}
          />
        ) : null}
        {frameMismatch ? (
          <Alert severity="info">
            {productionTexts.acceptResultDialog.frameMismatch({
              width: frameMismatch.width,
              height: frameMismatch.height,
              rate: frameRateText(frameMismatch.frameRate),
              fps
            })}
          </Alert>
        ) : durationMismatch ? (
          <Alert severity="info">
            {productionTexts.acceptResultDialog.durationMismatch({
              originalSeconds: seconds(target?.originalFrames),
              windowSeconds: seconds(target?.windowFrames),
              holdLast: target && target.originalFrames! < target.windowFrames!
            })}
          </Alert>
        ) : null}
        {recut ? null : (
          <TextField
            select
            size="small"
            label={productionTexts.acceptResultDialog.section}
            value={options.mode}
            onChange={(e) => onOptions({ ...options, mode: e.target.value as AcceptOptions['mode'] })}
          >
            <MenuItem value="full" disabled={mismatch}>
              {productionTexts.acceptResultDialog.full}
            </MenuItem>
            <MenuItem value="cut">{productionTexts.acceptResultDialog.cut}</MenuItem>
          </TextField>
        )}
        {options.mode === 'cut' ? (
          // Две колонки оставляют место полной подписи удержания кадра и её единице измерения.
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(220px, 100%), 1fr))', gap: 1 }}>
            <TextField
              size="small"
              type="number"
              label={productionTexts.acceptResultDialog.cutStart}
              value={options.cutStart}
              onChange={(e) => onOptions({ ...options, cutStart: thousandths(e.target.value) })}
              inputProps={{ step: 1 / fps }}
              {...boundary(options.cutStart ?? 0)}
            />
            <TextField
              size="small"
              type="number"
              label={productionTexts.acceptResultDialog.cutEnd}
              value={options.cutEnd}
              onChange={(e) => onOptions({ ...options, cutEnd: thousandths(e.target.value) })}
              inputProps={{ step: 1 / fps }}
              {...boundary(options.cutEnd ?? 0)}
            />
            <TextField
              size="small"
              label={productionTexts.acceptResultDialog.speed}
              value={options.speed}
              // Запятая — привычная русская запись дроби; Go разбирает множитель только с точкой.
              onChange={(e) => onOptions({ ...options, speed: e.target.value.replace(',', '.') })}
              helperText={productionTexts.acceptResultDialog.speedHint}
            />
            <TextField
              size="small"
              type="number"
              label={productionTexts.acceptResultDialog.holdFirst}
              value={options.holdFirst ?? 0}
              onChange={(e) => onOptions({ ...options, holdFirst: Number(e.target.value) })}
              inputProps={{ min: 0, step: 1 }}
            />
            <TextField
              size="small"
              type="number"
              label={productionTexts.acceptResultDialog.holdLast}
              value={options.holdLast ?? 0}
              onChange={(e) => onOptions({ ...options, holdLast: Number(e.target.value) })}
              inputProps={{ min: 0, step: 1 }}
            />
          </Box>
        ) : null}
        {fitted ? (
          <Box>
            <ActionButton
              size="small"
              variant="outlined"
              startIcon={<FitScreenIcon />}
              title={productionTexts.acceptResultDialog.fitEndHint}
              disabled={fitted.end === null}
              disabledReason={fitted.reason}
              onClick={() => fitted.end !== null && onOptions({ ...options, cutEnd: fitted.end })}
            >
              {productionTexts.acceptResultDialog.fitEnd}
            </ActionButton>
          </Box>
        ) : null}
        {cutResult ? (
          <Alert severity={cutResult.severity} data-testid="accept-cut-result">
            {cutResult.text}
          </Alert>
        ) : null}
        {target && onPreview ? (
          <CutPreviewPanel
            key={target.dir}
            parameters={JSON.stringify(previewOptions)}
            disabledReason={previewReason}
            fps={fps}
            onPreview={() => onPreview(previewOptions)}
          />
        ) : null}
        <Alert severity="info">{recut ? productionTexts.acceptResultDialog.recutConsequences : productionTexts.acceptResultDialog.consequences}</Alert>
      </Stack>
    </ConfirmationDialog>
  );
}

/** Частота ffprobe «30000/1001» — для человека «29,97»; неизвестная — «?». */
function frameRateText(rate: string): string {
  const [numerator, denominator = '1'] = rate.split('/');
  const value = Number(numerator) / Number(denominator);
  return Number.isFinite(value) && value > 0 ? String(Math.round(value * 100) / 100).replace('.', ',') : '?';
}
