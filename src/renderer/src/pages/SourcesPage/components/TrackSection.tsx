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
        Трек
      </Typography>
      {trackNew ? <Chip label={`Новый: ${trackNew}`} onDelete={onClear} sx={{ alignSelf: 'flex-start', mb: 1 }} /> : null}
      {track && !trackNew ? (
        <>
          <Typography variant="body2" color="text.secondary">
            {track.original_name} · {formatBytes(track.bytes)} · {formatDuration(track.duration_seconds)}
          </Typography>
          <audio controls preload="none" src={fileUrl(track.path)} style={{ width: '100%', marginTop: 12, marginBottom: 12 }} />
        </>
      ) : null}
      {/* Управление воспроизведением и удалением выбора остаётся вне кликабельной области загрузки. */}
      <FileDropZone
        label="Загрузка трека"
        kind="audio"
        onFiles={onDrop}
        onPick={onPick}
        hint="Один файл MP3."
        message="Перетащите MP3 или нажмите для выбора"
      />
    </Paper>
  );
}
