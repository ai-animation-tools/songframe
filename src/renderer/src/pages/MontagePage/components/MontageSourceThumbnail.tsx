import { commonTexts } from '@shared/texts/common';
import { montageTexts } from '@shared/texts/montage';
import { useEffect, useRef, useState, type ReactElement } from 'react';
import ImageOutlinedIcon from '@mui/icons-material/ImageOutlined';
import MovieOutlinedIcon from '@mui/icons-material/MovieOutlined';
import PlayCircleOutlineIcon from '@mui/icons-material/PlayCircleOutline';
import ZoomInIcon from '@mui/icons-material/ZoomIn';
import { Box, ButtonBase, Stack, Typography } from '@mui/material';
import type { MontageSource } from '@shared/montage';
import { projectMediaUrl } from '../model';
import { requestSourceThumbnail } from '../sourceThumbnails';

/** Опоры загружаются как изображения, а первый кадр видео запрашивается только для видимой карточки. */
export function MontageSourceThumbnail({
  project,
  source,
  sceneLabel,
  onOpen
}: {
  project: string;
  source: MontageSource;
  sceneLabel: string;
  onOpen(): void;
}): ReactElement {
  const containerRef = useRef<HTMLButtonElement>(null);
  const url = projectMediaUrl(project, source.path);
  const [poster, setPoster] = useState<{ url: string; image: string } | null>(null);
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const imageUrl = source.kind === 'card' ? url : poster?.url === url ? poster.image : undefined;
  const failed = failedUrl === url;
  const alt = montageTexts.sourceLabel({ title: sceneLabel, label: source.label });

  useEffect(() => {
    const container = containerRef.current;
    if (source.kind !== 'video' || !container) return;
    let disposed = false;
    let finished = false;
    let request: ReturnType<typeof requestSourceThumbnail> | null = null;
    let observer: IntersectionObserver | undefined;

    const cancel = (): void => {
      const pending = request;
      request = null;
      pending?.cancel();
    };
    const load = (): void => {
      if (disposed || finished || request) return;
      const pending = requestSourceThumbnail(url);
      request = pending;
      void pending.promise.then(
        (image) => {
          if (disposed || request !== pending) return;
          request = null;
          finished = true;
          setPoster({ url, image });
          observer?.disconnect();
        },
        (error: unknown) => {
          if (disposed || request !== pending) return;
          request = null;
          if (error instanceof Error && error.name === 'AbortError') return;
          finished = true;
          setFailedUrl(url);
          observer?.disconnect();
        }
      );
    };

    // Скрытая панель и карточки за границами прокрутки не занимают очередь декодирования.
    if (typeof IntersectionObserver === 'undefined') load();
    else {
      observer = new IntersectionObserver((entries) => {
        if (entries.some((entry) => entry.isIntersecting)) load();
        else cancel();
      });
      observer.observe(container);
    }

    return () => {
      disposed = true;
      observer?.disconnect();
      cancel();
    };
  }, [url, source.kind]);

  return (
    <ButtonBase
      ref={containerRef}
      onClick={onOpen}
      aria-label={montageTexts.openMaterial(alt)}
      sx={{
        aspectRatio: '16 / 9',
        width: '100%',
        position: 'relative',
        display: 'block',
        bgcolor: '#000',
        borderRadius: 0.5,
        overflow: 'hidden',
        mb: 1,
        '&.Mui-focusVisible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: 2 },
        '&:hover .material-open-hint': { bgcolor: 'rgba(0,0,0,0.85)' }
      }}
    >
      {imageUrl && !failed ? (
        <Box
          component="img"
          src={imageUrl}
          alt={alt}
          loading="lazy"
          draggable={false}
          onError={() => setFailedUrl(url)}
          sx={{ display: 'block', width: '100%', height: '100%', objectFit: 'contain' }}
        />
      ) : (
        <Stack role="img" aria-label={alt} alignItems="center" justifyContent="center" spacing={0.5} sx={{ height: '100%', color: 'grey.400', p: 1 }}>
          {source.kind === 'card' ? <ImageOutlinedIcon /> : <MovieOutlinedIcon />}
          <Typography variant="caption" textAlign="center">
            {failed ? montageTexts.previewUnavailable : montageTexts.previewLoading}
          </Typography>
        </Stack>
      )}
      {/* Просмотр отделён от добавления: кнопка открывает сам файл, не меняя дорожку. */}
      <Stack
        className="material-open-hint"
        aria-hidden
        direction="row"
        alignItems="center"
        gap={0.5}
        sx={{
          position: 'absolute',
          bottom: 4,
          left: 4,
          px: 0.75,
          py: 0.25,
          borderRadius: 0.5,
          bgcolor: 'rgba(0,0,0,0.65)',
          color: '#fff',
          pointerEvents: 'none'
        }}
      >
        {source.kind === 'video' ? <PlayCircleOutlineIcon fontSize="small" /> : <ZoomInIcon fontSize="small" />}
        <Typography component="span" variant="caption">
          {source.kind === 'video' ? commonTexts.watch : montageTexts.enlarge}
        </Typography>
      </Stack>
    </ButtonBase>
  );
}
