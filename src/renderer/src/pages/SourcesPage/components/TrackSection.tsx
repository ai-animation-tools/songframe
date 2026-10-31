import { sourcesTexts } from '@shared/texts/sources';
/** Текущий MP3 и выбор его замены. */
import type { ReactElement } from 'react';
import { Chip, Paper, Typography } from '@mui/material';
import type { SourceManifest } from '@shared/types';
import { formatBytes, formatDuration } from '../../../format';
import { FileDropZone } from '../../../components/FileDropZone';

interface Props {
  track: SourceManifest['track'];
  trackNew: string | null;
  fileUrl: (path: string) => string;
  onPick: () => Promise<void>;
  onClear: () => void;
  onDrop: (paths: string[]) => void;
}

export function TrackSection({ track, trackNew, fileUrl, onPick, onClear, onDrop }: Props): ReactElement {
  return (
    <Paper variant="outlined" sx={{ p: 2, display: 'flex', flexDirection: 'column' }}>
      <Typography variant="subtitle1" fontWeight={600} gutterBottom>
        {sourcesTexts.track}
      </Typography>
      {trackNew ? <Chip label={sourcesTexts.newTrack({ path: trackNew })} onDelete={onClear} sx={{ alignSelf: 'flex-start', mb: 1 }} /> : null}
      {track && !trackNew ? (
        <>
          <Typography variant="body2" color="text.secondary">
            {track.original_name} · {formatBytes(track.bytes)} · {formatDuration(track.duration_seconds)}
          </Typography>
          <audio controls preload="none" src={fileUrl(track.path)} style={{ width: '100%', marginTop: 12, marginBottom: 12 }} />
        </>
      ) : null}
      {!track && !trackNew ? (
        <Typography variant="body2" color="error" sx={{ mb: 1 }}>
          {sourcesTexts.trackRequired}
        </Typography>
      ) : null}
      {/* Управление воспроизведением и удалением выбора остаётся вне кликабельной области загрузки. */}
      <FileDropZone
        label={sourcesTexts.uploadTrack}
        kind="audio"
        onFiles={onDrop}
        onPick={onPick}
        hint={sourcesTexts.trackFileHint}
        message={sourcesTexts.trackFileMessage}
      />
    </Paper>
  );
}
