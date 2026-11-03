import { montageTexts } from '@shared/texts/montage';
import type { ReactElement } from 'react';
import { Typography } from '@mui/material';

/** Клавиши перечислены под плеером в том же виде, что и под шкалой таймингов. */
export function MontageShortcuts(): ReactElement {
  return (
    <Typography variant="caption" color="text.secondary" display="block">
      {montageTexts.shortcuts}
    </Typography>
  );
}
