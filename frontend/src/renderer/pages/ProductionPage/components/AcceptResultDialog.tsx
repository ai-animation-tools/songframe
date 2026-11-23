import { productionTexts } from '@shared/texts/production';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
/** Параметры переноса результата в assets с сохранением выбранного монтажного участка. */
import type { ReactElement } from 'react';
import { Alert, Box, Checkbox, FormControlLabel, MenuItem, Stack, TextField } from '@mui/material';
import type { AcceptOptions } from '@shared/types';
import type { AcceptTarget } from '../decisions';
import { cutFrameOf, cutSeconds, DEFAULT_FPS } from '@shared/video';
import { ConfirmationDialog } from '../../../components/ConfirmationDialog';

export function AcceptResultDialog({
  target,
  options,
  onOptions,
  onClose,
  onConfirm
}: {
  target: AcceptTarget | null;
  options: AcceptOptions;
  onOptions(value: AcceptOptions): void;
  onClose(): void;
  onConfirm(): void;
}): ReactElement {
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
  return (
    <ConfirmationDialog
      open={!!target}
      explicitCancelOnly
      onClose={onClose}
      title={productionTexts.acceptResultDialog.title({ shot: target?.shot ?? '' })}
      onConfirm={onConfirm}
      confirmLabel={target?.hasAsset ? productionTexts.acceptResultDialog.replace : productionTexts.acceptResultDialog.accept}
      confirmIcon={<CheckCircleIcon />}
      confirmColor="error"
      confirmDisabled={!target?.resultToken || !!target?.speechMissing || (!!target?.hasAsset && !options.replaceExisting)}
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
              onChange={(e) => onOptions({ ...options, speed: e.target.value })}
              helperText={productionTexts.acceptResultDialog.speedHint}
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
        <Alert severity="info">{productionTexts.acceptResultDialog.consequences}</Alert>
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
