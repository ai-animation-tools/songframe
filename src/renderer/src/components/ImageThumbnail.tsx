/** Миниатюра-кнопка: щелчок или Enter открывает изображение крупно в общей ImageGallery. */
import type { ReactElement } from 'react';
import { Box, ButtonBase, Tooltip } from '@mui/material';

export function ImageThumbnail({
  path,
  label,
  onOpen,
  width = '100%',
  aspectRatio = '16 / 9',
  fit = 'contain',
  highlight,
  dashed = false,
  title
}: {
  /** Абсолютный путь файла изображения. */
  path: string;
  /** Короткая подпись для доступного имени и alt, без пути. */
  label: string;
  onOpen(): void;
  width?: number | string;
  /** Пропорция области миниатюры; null — по размеру самого изображения. */
  aspectRatio?: string | null;
  fit?: 'contain' | 'cover';
  /** Рамка состояния цветом темы, например у утверждённой опоры или опоры, о которой задан вопрос. */
  highlight?: 'primary' | 'success' | 'warning';
  /** Пунктирная рамка: кандидат, ещё не принятый пользователем. */
  dashed?: boolean;
  /** Подсказка при наведении: технические сведения вроде пути файла, которые не нужны в подписи. */
  title?: string;
}): ReactElement {
  const button = (
    <ButtonBase
      onClick={onOpen}
      aria-label={`Открыть крупно: ${label}`}
      sx={{
        display: 'block',
        width,
        maxWidth: '100%',
        borderRadius: 1.5,
        overflow: 'hidden',
        bgcolor: 'action.hover',
        border: highlight ? 2 : 0,
        borderStyle: dashed ? 'dashed' : 'solid',
        borderColor: highlight ? `${highlight}.main` : undefined,
        '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 }
      }}
    >
      <Box
        component="img"
        src={window.api.shell.fileUrl(path)}
        alt={label}
        sx={{ display: 'block', width: '100%', aspectRatio: aspectRatio ?? undefined, objectFit: fit, cursor: 'zoom-in' }}
      />
    </ButtonBase>
  );
  return title ? (
    <Tooltip title={title} enterDelay={600}>
      {button}
    </Tooltip>
  ) : (
    button
  );
}
