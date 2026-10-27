import { Close, FitScreen, AspectRatio } from '@mui/icons-material';
import { useCallback, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { ArrowBack, ArrowForward } from '@mui/icons-material';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import type { MontageSource } from '@shared/montage';
import { projectMediaUrl } from '../model';

/** Просмотр материала перед добавлением: видео запускается вручную, опора открывается в масштабе 1:1. */
export function MontageMaterialDialog({
  project,
  source,
  position,
  total,
  onPrevious,
  onNext,
  onClose
}: {
  project: string;
  source: MontageSource;
  position: number;
  total: number;
  onPrevious?: () => void;
  onNext?: () => void;
  onClose(): void;
}): ReactElement {
  const titleId = useId();
  const paperRef = useRef<HTMLDivElement>(null);
  const [originalSize, setOriginalSize] = useState(true);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const url = projectMediaUrl(project, source.path);
  const failed = failedUrl === url;
  const isImage = source.kind === 'card';
  const title = `${source.scene} — ${source.title}`;
  const materialType = isImage ? 'Опорное изображение' : source.original ? 'Видео · полный оригинал' : 'Видео · принятый материал';

  const navigate = (callback: (() => void) | undefined): void => {
    if (!callback) return;
    // Содержимое пересоздаётся при переходе; сохраняем фокус на диалоге, чтобы следующие стрелки продолжали листать материалы.
    paperRef.current?.focus({ preventScroll: true });
    setOriginalSize(true);
    setFailedUrl(null);
    callback();
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
    if (event.key !== 'ArrowLeft' && event.key !== 'ArrowRight') return;
    // Перехватываем стрелки до нативных controls видео, чтобы они листали материалы, в том числе при фокусе на плеере.
    event.preventDefault();
    event.stopPropagation();
    navigate(event.key === 'ArrowLeft' ? onPrevious : onNext);
  };

  const attachVideo = useCallback(
    (video: HTMLVideoElement | null) => {
      if (!video) return;
      // Portal монтирует содержимое позже диалога; callback привязан к самому video и восстанавливает src после очистки StrictMode.
      if (video.getAttribute('src') !== url) video.src = url;
      return () => {
        // Закрытие просмотра немедленно останавливает звук и освобождает источник видео.
        video.pause();
        video.removeAttribute('src');
        video.load();
      };
    },
    [url]
  );

  return (
    <Dialog
      open
      onClose={onClose}
      onKeyDownCapture={handleKeyDown}
      aria-labelledby={titleId}
      maxWidth={false}
      fullWidth
      slotProps={{
        paper: {
          ref: paperRef,
          tabIndex: -1,
          sx: { width: 'calc(100% - 32px)', height: 'calc(100% - 32px)', maxHeight: 'calc(100% - 32px)', m: 2 }
        }
      }}
    >
      <DialogTitle id={titleId} sx={{ overflowWrap: 'anywhere' }}>
        <Typography component="span" variant="overline" display="block" color="text.secondary">
          {materialType}
        </Typography>
        {title}
        <Typography component="span" variant="body2" display="block" color="text.secondary">
          {source.label}
        </Typography>
        <Box component="span" sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, mt: 1 }}>
          <Button startIcon={<ArrowBack />} aria-label="Предыдущий материал" disabled={!onPrevious} onClick={() => navigate(onPrevious)}>
            Назад
          </Button>
          <Typography component="span" variant="body2" color="text.secondary">
            Материал {position + 1} из {total}
          </Typography>
          <Button endIcon={<ArrowForward />} aria-label="Следующий материал" disabled={!onNext} onClick={() => navigate(onNext)}>
            Вперёд
          </Button>
        </Box>
      </DialogTitle>
      <DialogContent key={`${source.id}:${url}`} sx={{ p: 0, mx: 2, minHeight: 0, flex: 1, overflow: 'auto', bgcolor: 'background.default' }}>
        {failed ? (
          <Alert severity="error" sx={{ m: 2 }}>
            {isImage ? 'Не удалось открыть изображение материала.' : 'Не удалось воспроизвести видео материала.'} Проверьте, что файл доступен в папке проекта.
          </Alert>
        ) : null}
        {isImage ? (
          <Box
            key={originalSize ? 'original' : 'fit'}
            sx={{
              display: failed ? 'none' : 'flex',
              width: originalSize ? 'max-content' : '100%',
              height: originalSize ? 'max-content' : '100%',
              minWidth: '100%',
              minHeight: '100%',
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <Box
              component="img"
              src={url}
              alt={`${title}: ${source.label}`}
              onError={() => setFailedUrl(url)}
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
        ) : (
          <Box
            component="video"
            ref={attachVideo}
            src={url}
            controls
            playsInline
            preload="metadata"
            aria-label={`${title}: ${source.label}`}
            onError={() => setFailedUrl(url)}
            sx={{ display: failed ? 'none' : 'block', width: '100%', height: '100%', objectFit: 'contain', bgcolor: '#000' }}
          />
        )}
      </DialogContent>
      <DialogActions sx={{ flexWrap: 'wrap', gap: 1 }}>
        {isImage ? (
          <>
            <Button
              startIcon={<AspectRatio />}
              onClick={() => setOriginalSize(true)}
              aria-pressed={originalSize}
              variant={originalSize ? 'contained' : 'outlined'}
            >
              Оригинальный размер (1:1)
            </Button>
            <Button
              startIcon={<FitScreen />}
              onClick={() => setOriginalSize(false)}
              aria-pressed={!originalSize}
              variant={originalSize ? 'outlined' : 'contained'}
            >
              Вписать в окно
            </Button>
          </>
        ) : null}
        <Button startIcon={<Close />} onClick={onClose}>
          Закрыть
        </Button>
      </DialogActions>
    </Dialog>
  );
}
