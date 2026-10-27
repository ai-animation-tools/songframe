import type { ReactElement, RefObject } from 'react';
import { Box } from '@mui/material';
import type { DashboardShot } from '@shared/types';

/** Видео заменяет статичную миниатюру; для сцен без видео сохраняем изображение или заглушку. */
export function SceneCardPreview({
  shot,
  videoPath,
  videoRef
}: {
  shot: DashboardShot;
  videoPath: string | null;
  videoRef: RefObject<HTMLVideoElement | null>;
}): ReactElement {
  const style = { width: '100%', aspectRatio: '16 / 9', objectFit: 'cover', borderRadius: 4, display: 'block' } as const;
  if (videoPath) {
    return (
      <video
        key={videoPath}
        ref={videoRef}
        src={window.api.shell.fileUrl(videoPath)}
        poster={shot.thumbnail ? window.api.shell.fileUrl(shot.thumbnail) : undefined}
        muted
        playsInline
        preload="metadata"
        style={style}
      />
    );
  }
  if (shot.thumbnail) return <img src={window.api.shell.fileUrl(shot.thumbnail)} alt={shot.id} style={style} />;
  return <Box sx={{ aspectRatio: '16 / 9', bgcolor: 'action.hover', borderRadius: 1 }} />;
}
