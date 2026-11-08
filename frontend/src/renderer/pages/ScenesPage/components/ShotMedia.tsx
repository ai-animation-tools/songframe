import { scenesTexts } from '@shared/texts/scenes';
import type { ReactElement } from 'react';
import type { DashboardShot } from '@shared/types';
import { Alert, Box, Stack, Typography } from '@mui/material';
import PlayArrowIcon from '@mui/icons-material/PlayArrow';
import PauseIcon from '@mui/icons-material/Pause';
import { useSynchronizedVideos } from '../useSynchronizedVideos';
import { ShotSection } from './ShotSection';
import { ActionButton } from '../../../components/ActionButton';

/** Одинаковая область видео и подписи под ней сохраняют выравнивание пары при длинном рецепте монтажа. */
export function ShotMedia({ shot }: { shot: DashboardShot }): ReactElement | null {
  const asset = shot.asset;
  const edit = asset?.edit;
  const comparison = useSynchronizedVideos({ edit: edit ?? null, originalPath: asset?.original ?? null, videoPath: asset?.video ?? null });
  const recipe = edit
    ? [
        edit.stillAt !== null
          ? scenesTexts.mediaEdit.still({ time: edit.stillAt.toFixed(2) })
          : edit.sourceInterval
            ? scenesTexts.mediaEdit.interval({ start: edit.sourceInterval[0].toFixed(2), end: edit.sourceInterval[1].toFixed(2) })
            : scenesTexts.mediaEdit.wholeOriginal,
        edit.speed && edit.speed !== '1' ? scenesTexts.mediaEdit.speed({ speed: edit.speed }) : null,
        edit.holdFirst ? scenesTexts.mediaEdit.holdFirst({ duration: edit.holdFirst }) : null,
        edit.holdLast ? scenesTexts.mediaEdit.holdLast({ duration: edit.holdLast }) : null,
        scenesTexts.mediaEdit.duration({ frames: edit.frames, duration: edit.duration.toFixed(2) })
      ].filter(Boolean)
    : [];
  const viewport = { aspectRatio: '16 / 9', bgcolor: '#000', borderRadius: 1, overflow: 'hidden', display: 'grid', placeItems: 'center' };
  const videoStyle = { width: '100%', height: '100%', objectFit: 'contain' as const, display: 'block' };

  return asset ? (
    <ShotSection title={scenesTexts.mediaEdit.acceptedAndOriginal}>
      <Stack spacing={1}>
        {comparison.error ? <Alert severity="warning">{comparison.error}</Alert> : null}
        <Box sx={{ display: 'grid', gridTemplateColumns: { xs: 'minmax(0, 1fr)', md: 'repeat(2, minmax(0, 1fr))' }, gap: 1, alignItems: 'start' }}>
          <Box sx={{ minWidth: 0 }}>
            <Box sx={viewport}>
              {asset.original ? (
                <video
                  ref={comparison.originalRef}
                  aria-label={scenesTexts.mediaEdit.original}
                  controls
                  preload="metadata"
                  src={window.api.shell.fileUrl(asset.original)}
                  style={videoStyle}
                />
              ) : (
                <Typography variant="body2" color="white">
                  {scenesTexts.mediaEdit.missingFile}
                </Typography>
              )}
            </Box>
            <Typography component="p" variant="caption" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
              {scenesTexts.mediaEdit.originalCaption({ media: asset.originalMedia })}
            </Typography>
          </Box>
          <Box sx={{ minWidth: 0 }}>
            <Box sx={viewport}>
              {asset.video ? (
                <video
                  ref={comparison.acceptedRef}
                  aria-label={scenesTexts.mediaEdit.accepted}
                  controls
                  preload="metadata"
                  src={window.api.shell.fileUrl(asset.video)}
                  style={videoStyle}
                />
              ) : (
                <Typography variant="body2" color="white">
                  {scenesTexts.mediaEdit.missingFile}
                </Typography>
              )}
            </Box>
            <Typography component="p" variant="caption" color="text.secondary" sx={{ mt: 0.5, overflowWrap: 'anywhere' }}>
              {scenesTexts.mediaEdit.acceptedCaption({ recipe: recipe.join(', ') })}
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
            disabledReason={!asset.original || !asset.video ? scenesTexts.mediaEdit.bothRequired : (comparison.error ?? scenesTexts.mediaEdit.loading)}
            onClick={comparison.toggle}
          >
            {comparison.synchronized ? scenesTexts.mediaEdit.pauseTogether : scenesTexts.mediaEdit.playTogether}
          </ActionButton>
        </Box>
      </Stack>
    </ShotSection>
  ) : shot.package?.request?.downloads.length ? (
    <ShotSection title={scenesTexts.mediaEdit.unaccepted}>
      <video
        controls
        preload="metadata"
        src={window.api.shell.fileUrl(shot.package.request.downloads[0])}
        style={{ width: '100%', maxWidth: 480, borderRadius: 4, background: '#000' }}
      />
    </ShotSection>
  ) : null;
}
