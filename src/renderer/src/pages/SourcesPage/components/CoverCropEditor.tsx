/** Квадрат поверх оригинала: перетаскивание и клавиатура меняют натуральные координаты. */
import { useId, useRef, type ReactElement } from 'react';
import { Box, Slider, Stack, Typography } from '@mui/material';
import type { CoverCrop } from '@shared/cover-generation';
import { keyboardCrop, moveCrop, resizeCrop } from './crop';

interface Props {
  image: { path: string; width: number; height: number };
  crop: CoverCrop;
  onCrop: (crop: CoverCrop) => void;
  disabled?: boolean;
}

export function CoverCropEditor({ image, crop, onCrop, disabled = false }: Props): ReactElement {
  const helpId = useId();
  const sizeId = useId();
  const imageRef = useRef<HTMLDivElement>(null);
  const drag = useRef<{ x: number; y: number; crop: CoverCrop } | null>(null);
  return (
    <Stack spacing={1.5}>
      <Box sx={{ display: 'flex', justifyContent: 'center', overflow: 'hidden', bgcolor: 'action.hover', borderRadius: 1 }}>
        {/* Пропорции оригинала задают размеры контейнера и сохраняют квадрат в пикселях экрана. */}
        <Box ref={imageRef} sx={{ position: 'relative', width: '100%', maxWidth: `${(image.width / image.height) * 400}px`, lineHeight: 0 }}>
          <Box component="img" src={window.api.shell.fileUrl(image.path)} alt="Созданная обложка" draggable={false} sx={{ width: '100%', display: 'block' }} />
          <Box
            role="group"
            tabIndex={disabled ? -1 : 0}
            aria-label="Квадратная область обложки"
            aria-describedby={helpId}
            aria-disabled={disabled}
            onKeyDown={(event) => {
              if (disabled || !event.key.startsWith('Arrow')) return;
              event.preventDefault();
              onCrop(keyboardCrop(crop, event.key, event.shiftKey, image));
            }}
            onPointerDown={(event) => {
              if (disabled || event.button !== 0) return;
              event.preventDefault();
              event.currentTarget.focus();
              event.currentTarget.setPointerCapture(event.pointerId);
              drag.current = { x: event.clientX, y: event.clientY, crop };
            }}
            onPointerMove={(event) => {
              const start = drag.current;
              const rect = imageRef.current?.getBoundingClientRect();
              if (disabled || !start || !rect?.width || !rect.height) return;
              onCrop(
                moveCrop(start.crop, ((event.clientX - start.x) * image.width) / rect.width, ((event.clientY - start.y) * image.height) / rect.height, image)
              );
            }}
            onPointerUp={() => {
              drag.current = null;
            }}
            onPointerCancel={() => {
              drag.current = null;
            }}
            onLostPointerCapture={() => {
              drag.current = null;
            }}
            sx={{
              position: 'absolute',
              left: `${(crop.x / image.width) * 100}%`,
              top: `${(crop.y / image.height) * 100}%`,
              width: `${(crop.size / image.width) * 100}%`,
              height: `${(crop.size / image.height) * 100}%`,
              boxSizing: 'border-box',
              border: '2px solid',
              borderColor: 'primary.main',
              boxShadow: '0 0 0 3000px rgba(0, 0, 0, 0.5)',
              cursor: disabled ? 'default' : 'move',
              touchAction: 'none',
              '&:focus-visible': { outline: '3px solid', outlineColor: 'common.white', outlineOffset: '-5px' }
            }}
          />
        </Box>
      </Box>
      <Typography id={sizeId} variant="body2">
        Размер области: {crop.size} × {crop.size} пикселей
      </Typography>
      <Slider
        aria-labelledby={sizeId}
        min={1}
        max={Math.min(image.width, image.height)}
        step={1}
        value={crop.size}
        disabled={disabled || Math.min(image.width, image.height) <= 1}
        onChange={(_event, value) => onCrop(resizeCrop(crop, value as number, image))}
        valueLabelDisplay="auto"
      />
      <Typography id={helpId} variant="caption" color="text.secondary">
        Перетащите квадрат и выберите его размер. Стрелки сдвигают область на 1 пиксель, Shift + стрелки — на 10.
      </Typography>
    </Stack>
  );
}
