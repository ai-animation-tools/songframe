import { describe, expect, it } from 'vitest';
import type { MontageClip, MontageDraft, MontageView } from '@shared/montage';
import { clipLength, historyReducer, initialDraft, montageLength, moveClip, rollCut, slipClip, trimClip } from './model';

const clip = (id: string, start = 10, end = 40): MontageClip => ({
  id,
  scene: id,
  path: `${id}.mp4`,
  kind: 'video',
  source_start_frame: start,
  source_end_frame_exclusive: end,
  source_frames: 100
});
const draft = (clips: MontageClip[]): MontageDraft => ({
  schema_version: 1,
  name: 'Проба',
  audio: { path: 'track.mp3', start_frame: 0, end_frame_exclusive: montageLength(clips) },
  clips,
  base_scenes_sha256: 'base',
  base_manifest_sha256: {}
});

describe('Кадровый монтаж', () => {
  it('начинает пробу с принятого монтажа, чтобы сохранить прежнюю обрезку сцены', () => {
    const view: MontageView = {
      scenarioStatus: 'ready',
      trackPath: 'source/track.mp3',
      trackSha256: null,
      duration: 5,
      lyricLines: [],
      lyricProblem: null,
      scenes: [{ id: 'M01', title: 'Сцена', startFrame: 0, endFrame: 60 }],
      sources: [
        { id: 'original', scene: 'M01', title: 'Сцена', label: 'Оригинал', path: 'original.mp4', kind: 'video', frames: 120, original: true },
        { id: 'accepted', scene: 'M01', title: 'Сцена', label: 'Монтаж', path: 'revisions/accepted.mp4', kind: 'video', frames: 60, original: false }
      ],
      scenesSha256: 'base',
      manifestSha256: {},
      saved: [],
      problems: []
    };
    expect(initialDraft(view, ['M01'], 'source/track.mp3').clips[0].path).toBe('revisions/accepted.mp4');
    // Предпочтительный источник сцены ставится на дорожку независимо от разделителей пути; неизвестный путь не меняет выбор.
    expect(initialDraft(view, ['M01'], 'source/track.mp3', { M01: 'original.mp4' }).clips[0].path).toBe('original.mp4');
    expect(initialDraft(view, ['M01'], 'source/track.mp3', { M01: 'revisions\\accepted.mp4' }).clips[0].path).toBe('revisions/accepted.mp4');
    expect(initialDraft(view, ['M01'], 'source/track.mp3', { M01: 'missing.mp4' }).clips[0].path).toBe('revisions/accepted.mp4');
  });
  it('меняет длительность карточки и переносит её стык без ненулевого начала источника', () => {
    const card: MontageClip = { ...clip('A', 0, 30), kind: 'card', source_frames: null };
    expect(trimClip([card], 'A', 'start', 5)[0]).toMatchObject({ source_start_frame: 0, source_end_frame_exclusive: 25 });
    expect(trimClip([card], 'A', 'end', 15)[0].source_end_frame_exclusive).toBe(45);
    expect(slipClip([card], 'A', 12)[0]).toEqual(card);
    const rolled = rollCut([clip('B'), card], 'B', 8);
    expect(rolled.map(clipLength)).toEqual([38, 22]);
    expect(rolled[1].source_start_frame).toBe(0);
    expect(rollCut([card, clip('B')], 'A', 8).map(clipLength)).toEqual([38, 22]);
  });
  it('обрезает до одного кадра и не выходит за исходник', () => {
    expect(clipLength(trimClip([clip('A')], 'A', 'start', 200)[0])).toBe(1);
    expect(trimClip([clip('A')], 'A', 'end', 200)[0].source_end_frame_exclusive).toBe(100);
    expect(trimClip([clip('A')], 'A', 'start', -200)[0].source_start_frame).toBe(0);
  });
  it('переносит стык, сохраняя длину, и учитывает запас обоих исходников', () => {
    const clips = [clip('A'), clip('B')];
    const rolled = rollCut(clips, 'A', 8);
    expect(rolled.map(clipLength)).toEqual([38, 22]);
    expect(montageLength(rolled)).toBe(montageLength(clips));
    expect(rollCut(clips, 'A', -100).map(clipLength)).toEqual([20, 40]);
    expect(clips[0].source_end_frame_exclusive).toBe(40);
  });
  it('slip сохраняет монтажную длину на обоих краях исходника', () => {
    const shifted = slipClip([clip('A')], 'A', 200)[0];
    expect([shifted.source_start_frame, shifted.source_end_frame_exclusive, clipLength(shifted)]).toEqual([70, 100, 30]);
    expect(slipClip([shifted], 'A', -200)[0].source_start_frame).toBe(0);
  });
  it('переставляет сцену без дубликатов и сохраняет длительность', () => {
    const moved = moveClip([clip('A'), clip('B'), clip('C')], 'A', 'C');
    expect(moved.map((item) => item.id)).toEqual(['B', 'A', 'C']);
    expect(montageLength(moved)).toBe(90);
  });
  it('отмена и повтор восстанавливают общий стык; новая правка очищает повтор', () => {
    const original = draft([clip('A'), clip('B')]);
    const changed = { ...original, clips: rollCut(original.clips, 'A', 5) };
    const first = historyReducer({ past: [], present: original, future: [] }, { type: 'commit', draft: changed });
    const undone = historyReducer(first, { type: 'undo' });
    expect(undone.present).toEqual(original);
    expect(historyReducer(undone, { type: 'redo' }).present).toEqual(changed);
    expect(historyReducer(undone, { type: 'commit', draft: { ...original, name: 'Другая проба' } }).future).toEqual([]);
  });
});
