import { FPS } from '@shared/video';
import type { MontageDraft } from '@shared/montage';
import { clipLength, rollCut } from './model';

/** Привязка использует абсолютную ось песни и не обещает стык за пределами исходников. */
export function snapCutDelta(draft: MontageDraft, leftId: string, delta: number, lineFrames: number[], pixelsPerSecond: number): number {
  const index = draft.clips.findIndex((clip) => clip.id === leftId);
  if (index < 0 || index >= draft.clips.length - 1 || pixelsPerSecond <= 0) return delta;
  const boundary = draft.audio.start_frame + draft.clips.slice(0, index + 1).reduce((sum, clip) => sum + clipLength(clip), 0);
  const candidate = boundary + delta;
  const threshold = (8 * FPS) / pixelsPerSecond;
  const nearest = lineFrames
    .filter((frame) => frame >= draft.audio.start_frame && frame <= draft.audio.end_frame_exclusive && Math.abs(frame - candidate) <= threshold)
    .sort((a, b) => Math.abs(a - candidate) - Math.abs(b - candidate))
    .find((frame) => {
      const shifted = rollCut(draft.clips, leftId, frame - boundary);
      return clipLength(shifted[index]) - clipLength(draft.clips[index]) === frame - boundary;
    });
  return nearest === undefined ? delta : nearest - boundary;
}
