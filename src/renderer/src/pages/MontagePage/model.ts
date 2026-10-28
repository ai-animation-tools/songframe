import { FPS } from '@shared/video';
import type { MontageClip, MontageDraft, MontageSource, MontageView } from '@shared/montage';

export const clipLength = (clip: MontageClip): number => clip.source_end_frame_exclusive - clip.source_start_frame;
export const montageLength = (clips: MontageClip[]): number => clips.reduce((sum, clip) => sum + clipLength(clip), 0);
const clamp = (value: number, min: number, max: number): number => Math.max(min, Math.min(max, Math.round(value)));

/** Все операции работают в целых кадрах; промежутков и неявного стоп-кадра в монтаже нет. */
export function trimClip(clips: MontageClip[], id: string, edge: 'start' | 'end', delta: number): MontageClip[] {
  return clips.map((clip) => {
    if (clip.id !== id) return clip;
    // У карточки нет временной шкалы исходника: меняется только длительность показа от кадра 0.
    if (clip.kind === 'card')
      return {
        ...clip,
        source_start_frame: 0,
        source_end_frame_exclusive: Math.max(1, Math.round(clip.source_end_frame_exclusive + (edge === 'start' ? -delta : delta)))
      };
    return edge === 'start'
      ? { ...clip, source_start_frame: clamp(clip.source_start_frame + delta, 0, clip.source_end_frame_exclusive - 1) }
      : {
          ...clip,
          source_end_frame_exclusive: clamp(
            clip.source_end_frame_exclusive + delta,
            clip.source_start_frame + 1,
            clip.source_frames ?? clip.source_end_frame_exclusive
          )
        };
  });
}

/** Общий стык передаёт кадры соседу: сумма длительностей и внешние края остаются прежними. */
export function rollCut(clips: MontageClip[], leftId: string, delta: number): MontageClip[] {
  const index = clips.findIndex((clip) => clip.id === leftId);
  if (index < 0 || index >= clips.length - 1) return clips;
  const left = clips[index];
  const right = clips[index + 1];
  const shift = clamp(
    delta,
    Math.max(1 - clipLength(left), right.kind === 'card' ? -Infinity : -right.source_start_frame),
    Math.min(left.kind === 'card' ? Infinity : (left.source_frames ?? left.source_end_frame_exclusive) - left.source_end_frame_exclusive, clipLength(right) - 1)
  );
  return clips.map((clip, i) =>
    i === index
      ? { ...clip, source_end_frame_exclusive: clip.source_end_frame_exclusive + shift }
      : i === index + 1
        ? clip.kind === 'card'
          ? { ...clip, source_end_frame_exclusive: clip.source_end_frame_exclusive - shift }
          : { ...clip, source_start_frame: clip.source_start_frame + shift }
        : clip
  );
}

export function slipClip(clips: MontageClip[], id: string, delta: number): MontageClip[] {
  return clips.map((clip) => {
    if (clip.id !== id || clip.kind === 'card') return clip;
    const shift = clamp(delta, -clip.source_start_frame, (clip.source_frames ?? clip.source_end_frame_exclusive) - clip.source_end_frame_exclusive);
    return { ...clip, source_start_frame: clip.source_start_frame + shift, source_end_frame_exclusive: clip.source_end_frame_exclusive + shift };
  });
}

export function moveClip(clips: MontageClip[], id: string, before: string | null): MontageClip[] {
  const clip = clips.find((item) => item.id === id);
  if (!clip || before === id) return clips;
  const rest = clips.filter((item) => item.id !== id);
  const index = before === null ? rest.length : rest.findIndex((item) => item.id === before);
  return [...rest.slice(0, index < 0 ? rest.length : index), clip, ...rest.slice(index < 0 ? rest.length : index)];
}

export function sourceClip(source: MontageSource, length: number): MontageClip {
  return {
    id: source.scene,
    scene: source.scene,
    path: source.path,
    kind: source.kind,
    source_start_frame: 0,
    source_end_frame_exclusive: Math.max(1, Math.min(length, source.frames ?? length)),
    source_frames: source.frames
  };
}

/** Путь источника сравнивается без учёта разделителей: ссылка приходит из другой страницы или ОС. */
export function samePath(a: string, b: string): boolean {
  return a.replaceAll('\\', '/') === b.replaceAll('\\', '/');
}

export function initialDraft(view: MontageView, selected: string[], trackPath: string, preferred: Record<string, string> = {}): MontageDraft {
  const scenes = view.scenes.filter((scene) => selected.includes(scene.id));
  const clips = scenes.flatMap((scene) => {
    const sources = view.sources.filter((source) => source.scene === scene.id);
    // Начальная проба повторяет текущий монтаж сцены, включая ранее выбранную обрезку.
    // Полный original выбирается явно, когда для новой склейки нужен дополнительный запас.
    // Со страницы производства проба открывается с результатом попытки этой сцены.
    const wanted = preferred[scene.id];
    const source =
      (wanted ? sources.find((item) => samePath(item.path, wanted)) : undefined) ??
      sources.find((item) => item.kind === 'video' && !item.original) ??
      sources.find((item) => item.original) ??
      sources[0];
    return source ? [sourceClip(source, scene.endFrame - scene.startFrame)] : [];
  });
  const start = scenes[0]?.startFrame ?? 0;
  return {
    schema_version: 1,
    name: 'Монтажная проба',
    audio: { path: trackPath, start_frame: start, end_frame_exclusive: scenes.at(-1)?.endFrame ?? start },
    clips,
    base_scenes_sha256: view.scenesSha256,
    base_manifest_sha256: { ...view.manifestSha256 }
  };
}

export function projectMediaUrl(project: string, relative: string): string {
  const separator = project.includes('\\') ? '\\' : '/';
  return window.api.shell.fileUrl(`${project.replace(/[\\/]+$/, '')}${separator}${relative.replace(/^[\\/]+/, '')}`);
}

export function frameLabel(frame: number): string {
  const seconds = Math.floor(frame / FPS);
  return `${Math.floor(seconds / 60)
    .toString()
    .padStart(2, '0')}:${(seconds % 60).toString().padStart(2, '0')}:${(frame % FPS).toString().padStart(2, '0')}`;
}

export interface DraftHistory {
  past: MontageDraft[];
  present: MontageDraft;
  future: MontageDraft[];
}
export type HistoryAction = { type: 'commit' | 'reset'; draft: MontageDraft } | { type: 'undo' | 'redo' } | { type: 'metadata'; path: string; frames: number };
export function historyReducer(state: DraftHistory, action: HistoryAction): DraftHistory {
  if (action.type === 'reset') return { past: [], present: action.draft, future: [] };
  if (action.type === 'commit')
    return JSON.stringify(state.present) === JSON.stringify(action.draft)
      ? state
      : { past: [...state.past.slice(-99), state.present], present: action.draft, future: [] };
  if (action.type === 'undo')
    return state.past.length ? { past: state.past.slice(0, -1), present: state.past.at(-1)!, future: [state.present, ...state.future] } : state;
  if (action.type === 'redo')
    return state.future.length ? { past: [...state.past, state.present], present: state.future[0], future: state.future.slice(1) } : state;
  if (action.type !== 'metadata') return state;
  // Метаданные не являются монтажной правкой: обновляем и историю, чтобы undo не возвращал неизвестную длину.
  const enrich = (draft: MontageDraft): MontageDraft => ({
    ...draft,
    clips: draft.clips.map((clip) =>
      clip.path !== action.path
        ? clip
        : {
            ...clip,
            source_frames: action.frames,
            source_start_frame: Math.min(clip.source_start_frame, action.frames - 1),
            source_end_frame_exclusive: Math.min(clip.source_end_frame_exclusive, action.frames)
          }
    )
  });
  return { past: state.past.map(enrich), present: enrich(state.present), future: state.future.map(enrich) };
}
