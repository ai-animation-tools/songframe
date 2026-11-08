import { commonTexts } from '@shared/texts/common';
import { montageTexts } from '@shared/texts/montage';
import { Close, FitScreen, AspectRatio } from '@mui/icons-material';
import { useCallback, useId, useRef, useState, type KeyboardEvent, type ReactElement } from 'react';
import { ArrowBack, ArrowForward } from '@mui/icons-material';
import { Alert, Box, Button, Dialog, DialogActions, DialogContent, DialogTitle, Typography } from '@mui/material';
import type { MontageSource } from '@shared/montage';
import { ActionButton } from '../../../components/ActionButton';
import { projectMediaUrl } from '../model';
import { MontageMaterialChip } from './MontageMaterialChip';

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
  const title = montageTexts.sceneTitle({ scene: source.scene, title: source.title });

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
        {/* Вид материала тем же чипом и цветом, что в каталоге: оригинал, принятый монтаж или непринятая попытка. */}
        <Box component="span" sx={{ display: 'flex', mb: 0.5 }}>
          <MontageMaterialChip source={source} />
        </Box>
        {title}
        <Typography component="span" variant="body2" display="block" color="text.secondary">
          {source.label}
        </Typography>
        <Box component="span" sx={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 1, mt: 1 }}>
          <ActionButton
            startIcon={<ArrowBack />}
            aria-label={montageTexts.previousMaterial}
            disabled={!onPrevious}
            disabledReason={montageTexts.firstMaterial}
            onClick={() => navigate(onPrevious)}
          >
            {commonTexts.back}
          </ActionButton>
          <Typography component="span" variant="body2" color="text.secondary">
            {montageTexts.materialPosition({ position: position + 1, total })}
          </Typography>
          <ActionButton
            endIcon={<ArrowForward />}
            aria-label={montageTexts.nextMaterial}
            disabled={!onNext}
            disabledReason={montageTexts.lastMaterial}
            onClick={() => navigate(onNext)}
          >
            {commonTexts.next}
          </ActionButton>
        </Box>
      </DialogTitle>
      <DialogContent key={`${source.id}:${url}`} sx={{ p: 0, mx: 2, minHeight: 0, flex: 1, overflow: 'auto', bgcolor: 'background.default' }}>
        {failed ? (
          <Alert severity="error" sx={{ m: 2 }}>
            {isImage ? montageTexts.materialImageFailed : montageTexts.materialVideoFailed}
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
              alt={montageTexts.sourceLabel({ title, label: source.label })}
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
            aria-label={montageTexts.sourceLabel({ title, label: source.label })}
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
              {montageTexts.originalSize}
            </Button>
            <Button
              startIcon={<FitScreen />}
              onClick={() => setOriginalSize(false)}
              aria-pressed={!originalSize}
              variant={originalSize ? 'outlined' : 'contained'}
            >
              {montageTexts.fitToWindow}
            </Button>
          </>
        ) : null}
        <Button startIcon={<Close />} onClick={onClose}>
          {commonTexts.close}
        </Button>
      </DialogActions>
    </Dialog>
  );
}
