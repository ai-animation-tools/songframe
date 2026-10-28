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
  return (
    <ConfirmationDialog
      open={!!target}
      onClose={onClose}
      title={`Принять результат ${target?.shot ?? ''}`}
      onConfirm={onConfirm}
      confirmLabel={target?.hasAsset ? 'Заменить комплект' : 'Принять'}
      confirmIcon={<CheckCircleIcon />}
      confirmColor="error"
      confirmDisabled={!target?.resultToken || (!!target?.hasAsset && !options.replaceExisting)}
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
        {target && !target.resultToken ? (
          <Alert severity="warning">Обновите пакет и откройте приёмку заново: данные показанного результата не подтверждены.</Alert>
        ) : null}
        <TextField
          select
          size="small"
          label="Монтажный участок"
          value={options.mode}
          onChange={(e) => onOptions({ ...options, mode: e.target.value as AcceptOptions['mode'] })}
        >
          <MenuItem value="full">Оригинал целиком совпадает с окном плана</MenuItem>
          <MenuItem value="cut">Участок оригинала (секунды, конец исключительно)</MenuItem>
        </TextField>
        {options.mode === 'cut' ? (
          <Box sx={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 1 }}>
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
          </Box>
        ) : null}
        <Typography variant="caption" color="text.secondary">
          Оригинал, принятый монтаж, кадры, промпт и сведения о приёмке будут сохранены в комплекте сцены. Рабочие пакеты плана будут очищены, карточки и списки
          — обновлены. Речевые планы с отдельным WAV принимайте через агента.
        </Typography>
      </Stack>
    </ConfirmationDialog>
  );
}
