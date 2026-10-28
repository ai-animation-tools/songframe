import type { ReactElement } from 'react';
import type { DashboardShot } from '@shared/types';
import { Alert, Box, Stack, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import { useSynchronizedVideos } from '../useSynchronizedVideos';
import { ShotSection } from './ShotSection';
import { ActionButton } from '../../../components/ActionButton';
import { countLabel } from '@shared/plural';

/** Одинаковая область видео и подписи под ней сохраняют выравнивание пары при длинном рецепте монтажа. */
export function ShotMedia({ shot }: { shot: DashboardShot }): ReactElement | null {
  const asset = shot.asset;
  const edit = asset?.edit;
  const comparison = useSynchronizedVideos({ edit: edit ?? null, originalPath: asset?.original ?? null, videoPath: asset?.video ?? null });
  const recipe = edit
    ? [
        edit.stillAt !== null
          ? `стоп-кадр оригинала на ${edit.stillAt.toFixed(2)} с`
          : edit.sourceInterval
            ? `участок оригинала ${edit.sourceInterval[0].toFixed(2)}–${edit.sourceInterval[1].toFixed(2)} с`
            : 'оригинал целиком',
        edit.speed && edit.speed !== '1' ? `скорость ${edit.speed}` : null,
        edit.holdFirst ? `удержание первого кадра ${edit.holdFirst} с` : null,
        edit.holdLast ? `удержание последнего кадра ${edit.holdLast} с` : null,
        `${countLabel(edit.frames, 'кадр', 'кадра', 'кадров')}, ${edit.duration.toFixed(2)} с`
      ].filter(Boolean)
    : [];
  const viewport = { aspectRatio: '16 / 9', bgcolor: '#000', borderRadius: 1, overflow: 'hidden', display: 'grid', placeItems: 'center' };
  const videoStyle = { width: '100%', height: '100%', objectFit: 'contain' as const, display: 'block' };

  return asset ? (
    <ShotSection title="Оригинал генерации и принятый монтаж">
      <Stack spacing={1}>
        {comparison.error ? <Alert severity="warning">{comparison.error}</Alert> : null}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1, alignItems: 'start' }}>
          <Box sx={{ minWidth: 0 }}>
            <Box sx={viewport}>
              {asset.original ? (
                <video
                  ref={comparison.originalRef}
                  aria-label="Оригинал генерации"
                  controls
                  preload="metadata"
                  src={window.api.shell.fileUrl(asset.original)}
                  style={videoStyle}
                />
              ) : (
                <Typography variant="body2" color="white">
                  файла нет
                </Typography>
              )}
            </Box>
            <Typography component="p" variant="caption" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
              Оригинал{asset.originalMedia ? ` · ${asset.originalMedia}` : ''}
            </Typography>
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Box sx={viewport}>
              {asset.video ? (
                <video
                  ref={comparison.acceptedRef}
                  aria-label="Принятый монтаж"
                  controls
                  preload="metadata"
                  src={window.api.shell.fileUrl(asset.video)}
                  style={videoStyle}
                />
              ) : (
                <Typography variant="body2" color="white">
                  файла нет
                </Typography>
              )}
            </Box>
            <Typography component="p" variant="caption" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
              Принятый монтаж · {recipe.join(', ')}
            </Typography>
          </Box>
        </Box>
        {edit?.note ? (
          <Typography variant="caption" color="text.secondary">
            {edit.note}
          </Typography>
        ) : null}
        <Box>
          <ActionButton
            variant="outlined"
            startIcon={comparison.synchronized ? <PauseIcon /> : <PlayArrowIcon />}
            disabled={!comparison.ready}
            disabledReason={
              !asset.original || !asset.video
                ? 'Для сравнения нужны оба видео: оригинал генерации и принятый монтаж.'
                : (comparison.error ?? 'Дождитесь загрузки обоих видео.')
            }
            onClick={comparison.toggle}
          >
            {comparison.synchronized ? 'Приостановить синхронно' : 'Воспроизвести синхронно'}
          </ActionButton>
        </Box>
      </Stack>
    </ShotSection>
  ) : shot.package?.request?.downloads.length ? (
    <ShotSection title="Результат генерации (не принят)">
      <video
        controls
        preload="metadata"
        src={window.api.shell.fileUrl(shot.package.request.downloads[0])}
        style={{ width: '100%', maxWidth: 480, borderRadius: 4, background: '#000' }}
      />
    </ShotSection>
  ) : null;
}
