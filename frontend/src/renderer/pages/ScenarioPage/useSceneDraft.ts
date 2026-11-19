import { scenarioTexts } from '@shared/texts/scenario';
import type { Dispatch, SetStateAction } from 'react';
import type { SceneShot, ScenesFile, StateDelta } from '@shared/types';
import { MIN_SHOT_FRAMES, mergeShots, splitShot, type SplitPlan } from '@shared/scene-editing';

/**
 * Изменяет планы одного черновика, сохраняя сплошную шкалу и ссылки наследования. Объединение и деление не меняют
 * коды остальных планов: к коду привязаны принятые видео, попытки и статусы вне сценария (`@shared/scene-editing`).
 */
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
      const value = Math.max(current.start_frame + MIN_SHOT_FRAMES, Math.min(next.end_frame_exclusive - MIN_SHOT_FRAMES, Math.round(frames)));
      const list = d.scenes.map((s, i) => (i === shotIndex ? { ...s, end_frame_exclusive: value } : i === shotIndex + 1 ? { ...s, start_frame: value } : s));
      return { ...d, scenes: list };
    });
  };
  const split = (plan: SplitPlan | null): void => {
    if (!scenes || !shot) return;
    if (!plan) {
      notify(scenarioTexts.notice.shotTooShort, 'warning');
      return;
    }
    const result = splitShot(scenes.scenes, shotIndex, plan);
    setScenes({ ...scenes, scenes: result.scenes });
    setSelected(result.id);
  };
  /** Объединяет выбранный план с count следующими; выбранным остаётся объединённый план с прежним кодом. */
  const merge = (count: number): void => {
    if (!scenes || !shot || shotIndex + count >= scenes.scenes.length) return;
    setScenes({ ...scenes, scenes: mergeShots(scenes.scenes, shotIndex, count) });
    setSelected(shot.id);
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

  return { shot, shotIndex, updateShot, setBoundary, split, merge, setDelta };
}
