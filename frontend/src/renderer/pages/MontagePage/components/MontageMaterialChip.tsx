import { montageTexts } from '@shared/texts/montage';
/** Вид материала сцены одним чипом: тот же цвет, что у карточки материала, в каталоге и в окне просмотра. */
import type { ReactElement } from 'react';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined';
import { Chip, Stack } from '@mui/material';
import type { MontageSource } from '@shared/montage';

export type MaterialColor = 'warning' | 'info' | 'success';

/** Результат попытки выделяется предупреждающим цветом: он ещё не принят и легко теряется среди принятых материалов. */
export function materialColor(source: MontageSource): MaterialColor | null {
  return source.kind === 'card' ? null : source.attempt ? 'warning' : source.original ? 'info' : 'success';
}

export function materialLabel(source: MontageSource): string {
  return source.kind === 'card'
    ? montageTexts.materialCard
    : source.attempt
      ? montageTexts.materialAttempt
      : source.original
        ? montageTexts.materialOriginal
        : montageTexts.materialAccepted;
}

export function MontageMaterialChip({ source, size = 'small' }: { source: MontageSource; size?: 'small' | 'medium' }): ReactElement {
  const color = materialColor(source);
  return (
    <Stack direction="row" gap={0.75} alignItems="center" component="span">
      {source.kind === 'card' ? <ImageOutlinedIcon fontSize="small" color="action" /> : <MovieOutlinedIcon fontSize="small" color="action" />}
      <Chip size={size} label={materialLabel(source)} color={color ?? 'default'} variant={source.attempt ? 'filled' : 'outlined'} />
    </Stack>
  );
}
