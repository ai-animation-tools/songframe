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
      title={`Принять результат ${target?.shot ?? ''}`}
      onConfirm={onConfirm}
      confirmLabel={target?.hasAsset ? 'Заменить комплект' : 'Принять'}
      confirmIcon={<CheckCircleIcon />}
      confirmColor="error"
      confirmDisabled={!target?.resultToken || !!target?.speechMissing || (!!target?.hasAsset && !options.replaceExisting)}
      confirmDisabledReason={
        !target?.resultToken
          ? 'Данные показанного результата не подтверждены: обновите пакет и откройте приёмку заново.'
          : target.speechMissing
            ? 'Это речевой план: сначала подготовьте WAV речи в блоке «Речь» этого пакета.'
            : 'Отметьте «Заменить принятый комплект этим результатом».'
      }
    >
      <Stack spacing={2} sx={{ mt: 1 }}>
        {target?.hasAsset ? (
          <Alert severity="warning">
            У плана {target.shot} уже есть принятый комплект. Новый результат займёт его место в assets/shots, а прежний комплект целиком переедет в
            assets/replaced/{target.shot}: оригинал, монтаж, опоры и промпт сохранятся, но в сборку он больше не войдёт. Аниматик после замены нужно
            пересобрать.
          </Alert>
        ) : null}
        {target?.hasAsset ? (
          <FormControlLabel
            control={<Checkbox checked={!!options.replaceExisting} onChange={(e) => onOptions({ ...options, replaceExisting: e.target.checked })} />}
            label="Заменить принятый комплект этим результатом"
          />
        ) : null}
        {mismatch ? (
          <Alert severity="info">
            Оригинал длиной {seconds(target?.originalFrames)} с не совпадает с окном плана {seconds(target?.windowFrames)} с, поэтому принять его целиком
            нельзя. Предложен участок {target && target.originalFrames! < target.windowFrames! ? 'с удержанием последнего кадра' : 'по длине окна'}; при
            необходимости поправьте его.
          </Alert>
        ) : null}
        <TextField
          select
          size="small"
          label="Монтажный участок"
          value={options.mode}
          onChange={(e) => onOptions({ ...options, mode: e.target.value as AcceptOptions['mode'] })}
        >
          <MenuItem value="full" disabled={mismatch}>
            Оригинал целиком совпадает с окном плана
          </MenuItem>
          <MenuItem value="cut">Участок оригинала (секунды, конец исключительно)</MenuItem>
        </TextField>
        {options.mode === 'cut' ? (
          <Box sx={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(140px, 1fr))', gap: 1 }}>
            <TextField
              size="small"
              type="number"
              label="Начало, с"
              value={options.cutStart}
              onChange={(e) => onOptions({ ...options, cutStart: Number(e.target.value) })}
              inputProps={{ step: 1 / FPS }}
            />
            <TextField
              size="small"
              type="number"
              label="Конец, с"
              value={options.cutEnd}
              onChange={(e) => onOptions({ ...options, cutEnd: Number(e.target.value) })}
              inputProps={{ step: 1 / FPS }}
            />
            <TextField
              size="small"
              label="Скорость"
              value={options.speed}
              onChange={(e) => onOptions({ ...options, speed: e.target.value })}
              helperText="множитель, например 1 или 0.8"
            />
            <TextField
              size="small"
              type="number"
              label="Удержать последний кадр, кадров"
              value={options.holdLast ?? 0}
              onChange={(e) => onOptions({ ...options, holdLast: Number(e.target.value) })}
              inputProps={{ min: 0, step: 1 }}
            />
          </Box>
        ) : null}
        <Typography variant="caption" color="text.secondary">
          Оригинал, принятый монтаж, кадры, промпт и сведения о приёмке будут сохранены в комплекте сцены. Рабочие пакеты плана будут очищены, карточки и списки
          — обновлены.
        </Typography>
      </Stack>
    </ConfirmationDialog>
  );
}
