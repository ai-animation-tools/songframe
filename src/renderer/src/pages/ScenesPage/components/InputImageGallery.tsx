import NavigateBeforeIcon from '@mui/icons-material/NavigateBefore';
import NavigateNextIcon from '@mui/icons-material/NavigateNext';
import CloseIcon from '@mui/icons-material/Close';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import { useId, useState, type ReactElement } from 'react';
import { Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';

interface InputImageGalleryProps {
  images: { imagePath: string; label: string }[];
  initialIndex: number;
  onClose(): void;
}

/** Открывает исходные входы без обрезки; режим 1:1 сохраняет размер файла и даёт прокрутку. */
export function InputImageGallery({ images, initialIndex, onClose }: InputImageGalleryProps): ReactElement {
  const [index, setIndex] = useState(Math.min(initialIndex, images.length - 1));
  const [originalSize, setOriginalSize] = useState(false);
  const titleId = useId();
  const image = images[index];

  const navigate = (nextIndex: number): void => {
    if (nextIndex < 0 || nextIndex >= images.length) return;
    setIndex(nextIndex);
    setOriginalSize(false);
  };

  return (
    <Dialog
      open
      onClose={onClose}
      aria-labelledby={titleId}
      maxWidth={false}
      fullWidth
      slotProps={{ paper: { sx: { width: 'calc(100% - 32px)', height: 'calc(100% - 32px)', maxHeight: 'calc(100% - 32px)', m: 2 } } }}
      onKeyDown={(event) => {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          navigate(index + (event.key === 'ArrowLeft' ? -1 : 1));
        }
      }}
    >
      <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
        <Typography component="span" variant="overline" display="block" color="text.secondary">
          Входное изображение · {index + 1} / {images.length}
        </Typography>
        {image.label}
      </DialogTitle>
      <DialogContent key={`${index}-${originalSize}`} sx={{ p: 0, mx: 2, minHeight: 0, flex: 1, overflow: 'auto', bgcolor: 'background.default' }}>
        <Box
          sx={{
            width: originalSize ? 'max-content' : '100%',
            height: originalSize ? 'max-content' : '100%',
            minWidth: '100%',
            minHeight: '100%',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center'
          }}
        >
          <Box
            component="img"
            src={window.api.shell.fileUrl(image.imagePath)}
            alt={image.label}
            sx={{
              display: 'block',
              flexShrink: 0,
              width: 'auto',
              height: 'auto',
              maxWidth: originalSize ? 'none' : '100%',
              maxHeight: originalSize ? 'none' : '100%',
              objectFit: 'contain'
            }}
          />
        </Box>
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        <Button startIcon={<NavigateBeforeIcon />} onClick={() => navigate(index - 1)} disabled={index === 0} aria-label="Предыдущее входное изображение">
          Назад
        </Button>
        <Button
          startIcon={<NavigateNextIcon />}
          onClick={() => navigate(index + 1)}
          disabled={index === images.length - 1}
          aria-label="Следующее входное изображение"
        >
          Вперёд
        </Button>
        <Button
          startIcon={<ZoomInIcon />}
          onClick={() => setOriginalSize((value) => !value)}
          aria-pressed={originalSize}
          variant={originalSize ? 'contained' : 'outlined'}
        >
          Оригинальный размер (1:1)
        </Button>
        <Button startIcon={<CloseIcon />} onClick={onClose}>
          Закрыть
        </Button>
      </DialogActions>
    </Dialog>
  );
}
