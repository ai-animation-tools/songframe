import { describe, expect, it } from 'vitest';
import type { MontageClip, MontageDraft } from '@shared/montage';
import { snapCutDelta } from './snapCut';

const clip = (id: string, start: number, end: number, frames = 100): MontageClip => ({
  id,
  scene: id,
  path: `${id}.mp4`,
  kind: 'video',
  source_start_frame: start,
  source_end_frame_exclusive: end,
  source_frames: frames
});
const draft: MontageDraft = {
  schema_version: 1,
  name: 'Проба',
  audio: { path: 'track.mp3', start_frame: 300, end_frame_exclusive: 360 },
  clips: [clip('A', 10, 40), clip('B', 10, 40)],
  base_scenes_sha256: '',
  base_manifest_sha256: {}
};

describe('Привязка склейки к строке песни', () => {
  it('выбирает ближайшую строку на абсолютной шкале и учитывает масштаб', () => {
    expect(snapCutDelta(draft, 'A', 3, [336, 334], 60)).toBe(4);
    expect(snapCutDelta(draft, 'A', 3, [338], 60)).toBe(3);
    expect(snapCutDelta(draft, 'A', 3, [338], 30)).toBe(8);
  });
  it('не привязывает к недостижимой строке или за пределами музыкального участка', () => {
    expect(snapCutDelta(draft, 'A', -9, [318], 30)).toBe(-9);
    expect(snapCutDelta(draft, 'A', 27, [362], 10)).toBe(27);
    expect(snapCutDelta(draft, 'B', 1, [334], 60)).toBe(1);
  });
});
