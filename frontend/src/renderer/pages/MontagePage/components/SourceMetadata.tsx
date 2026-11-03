import type { ReactElement } from 'react';
import { secondsToFrames } from '@shared/video';
import type { MontageSource } from '@shared/montage';
import { projectMediaUrl } from '../model';

/** Длина неизвестного оригинала поступает из браузера: для открытия монтажа ffprobe не нужен. */
export function SourceMetadata({
  project,
  sources,
  onMetadata
}: {
  project: string;
  sources: MontageSource[];
  onMetadata: (path: string, frames: number) => void;
}): ReactElement {
  return (
    <div hidden>
      {sources
        .filter((source) => source.kind === 'video' && source.frames === null)
        .map((source) => (
          <video
            key={source.path}
            preload="metadata"
            muted
            src={projectMediaUrl(project, source.path)}
            onLoadedMetadata={(event) => {
              const duration = event.currentTarget.duration;
              if (Number.isFinite(duration) && duration > 0) onMetadata(source.path, Math.max(1, secondsToFrames(duration)));
            }}
          />
        ))}
    </div>
  );
}
