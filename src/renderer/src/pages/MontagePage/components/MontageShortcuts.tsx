import type { ReactElement } from 'react';
import { Typography } from '@mui/material';

/** Клавиши перечислены под плеером в том же виде, что и под шкалой таймингов. */
export function MontageShortcuts(): ReactElement {
  return (
    <Typography variant="caption" color="text.secondary" display="block">
      Клавиши: Ctrl+Z отмена, Ctrl+Shift+Z или Ctrl+Y повтор, пробел воспроизведение / пауза, стрелки влево и вправо шаг на кадр, Delete удаление выбранного
      фрагмента с подтверждением.
    </Typography>
  );
}
