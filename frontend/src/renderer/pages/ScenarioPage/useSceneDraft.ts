import { scenarioTexts } from '@shared/texts/scenario';
import type { Dispatch, SetStateAction } from 'react';
import type { SceneShot, ScenesFile, StateDelta } from '@shared/types';
import { renumberShots } from '@shared/scene-editing';

/** Изменяет планы одного черновика, сохраняя сплошную шкалу и ссылки наследования. */
export function useSceneDraft(
  scenes: ScenesFile | null,
  selected: string | null,
  setScenes: Dispatch<SetStateAction<ScenesFile | null>>,
  setSelected: Dispatch<SetStateAction<string | null>>,
  notify: (message: string, severity: 'warning') => void
) {
  const shot = scenes?.scenes.find((s) => s.id === selected) ?? null;
  const shotIndex = scenes && shot ? scenes.scenes.indexOf(shot) : -1;
  const updateShot = (patch: Partial<SceneShot>): void =>
    setScenes((d) => d && shot && { ...d, scenes: d.scenes.map((s) => (s.id === shot.id ? { ...s, ...patch } : s)) });
  const setBoundary = (frames: number): void => {
    // Конец текущего плана и начало следующего двигаются вместе: шкала остаётся сплошной.
    setScenes((d) => {
      if (!d || shotIndex < 0 || shotIndex >= d.scenes.length - 1) return d;
      const current = d.scenes[shotIndex];
      const next = d.scenes[shotIndex + 1];
      const value = Math.max(current.start_frame + 15, Math.min(next.end_frame_exclusive - 15, Math.round(frames)));
      const list = d.scenes.map((s, i) => (i === shotIndex ? { ...s, end_frame_exclusive: value } : i === shotIndex + 1 ? { ...s, start_frame: value } : s));
      return { ...d, scenes: list };
    });
  };
  const split = (): void => {
    if (!scenes || !shot) return;
    const middle = Math.round((shot.start_frame + shot.end_frame_exclusive) / 2);
    if (middle - shot.start_frame < 15 || shot.end_frame_exclusive - middle < 15) {
      notify(scenarioTexts.notice.shotTooShort, 'warning');
      return;
    }
    const second: SceneShot = { ...shot, id: `${shot.id}.1`, start_frame: middle, state_from: shot.id, state_changes: {}, continuity: '' };
    const list = [...scenes.scenes];
    list.splice(shotIndex, 1, { ...shot, end_frame_exclusive: middle }, second);
    const renumbered = renumberShots(list);
    setScenes({ ...scenes, scenes: renumbered });
    setSelected(renumbered[shotIndex + 1].id);
  };
  const mergeNext = (): void => {
    if (!scenes || !shot || shotIndex >= scenes.scenes.length - 1) return;
    const next = scenes.scenes[shotIndex + 1];
    const merged: SceneShot = {
      ...shot,
      end_frame_exclusive: next.end_frame_exclusive,
      original: [shot.original, next.original].filter(Boolean).join(' / '),
      state_changes: { before: shot.state_changes.before, after: { ...(shot.state_changes.after ?? {}), ...(next.state_changes.after ?? {}) } }
    };
    const list = [...scenes.scenes];
    list.splice(shotIndex, 2, merged);
    const renumbered = renumberShots(list, new Map([[next.id, shot.id]]));
    setScenes({ ...scenes, scenes: renumbered });
    setSelected(renumbered[shotIndex].id);
  };
  const setDelta = (phase: 'before' | 'after', entity: string, value: Record<string, string | null>): void => {
    if (!shot) return;
    const delta: StateDelta = { ...(shot.state_changes[phase] ?? {}) };
    if (Object.keys(value).length) delta[entity] = value;
    else delete delta[entity];
    const changes = { ...shot.state_changes, [phase]: delta };
    if (!Object.keys(delta).length) delete changes[phase];
    updateShot({ state_changes: changes });
  };

  return { shot, shotIndex, updateShot, setBoundary, split, mergeNext, setDelta };
}
