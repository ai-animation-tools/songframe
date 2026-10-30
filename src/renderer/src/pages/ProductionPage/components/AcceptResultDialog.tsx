import { productionTexts } from '@shared/texts/production';
import CheckCircleIcon from '@mui/icons-material/CheckCircle';
/** Параметры переноса результата в assets с сохранением выбранного монтажного участка. */
import { FPS } from '@shared/video';
import type { ReactElement } from 'react';
import { Alert, Box, Checkbox, FormControlLabel, MenuItem, Stack, TextField, Typography } from '@mui/material';
import type { AcceptOptions } from '@shared/types';
import type { AcceptTarget } from '../decisions';
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
  const mismatch = !!target?.windowFrames && !!target.originalFrames && target.windowFrames !== target.originalFrames;
  const seconds = (frames?: number): string => ((frames ?? 0) / FPS).toFixed(2).replace('.', ',');
  return (
    <ConfirmationDialog
      open={!!target}
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
        {mismatch ? (
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
              onChange={(e) => onOptions({ ...options, cutStart: Number(e.target.value) })}
              inputProps={{ step: 1 / FPS }}
            />
            <TextField
              size="small"
              type="number"
              label={productionTexts.acceptResultDialog.cutEnd}
              value={options.cutEnd}
              onChange={(e) => onOptions({ ...options, cutEnd: Number(e.target.value) })}
              inputProps={{ step: 1 / FPS }}
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
        <Typography variant="caption" color="text.secondary">
          {productionTexts.acceptResultDialog.consequences}
        </Typography>
      </Stack>
    </ConfirmationDialog>
  );
}
