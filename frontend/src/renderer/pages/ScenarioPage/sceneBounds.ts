import { scenarioTexts } from '@shared/texts/scenario';
/**
 * Пересчёт границ планов по разметке песни без новой постановки. Каркас (`scene_scaffold --dry-run`) нарезает окна
 * по сохранённым трактовке и разметке; из него в реестр переносятся только окно плана, его строки песни и отметка
 * трека, а камера, действие, непрерывность, состояние и остальная постановка остаются прежними. Перенос идёт по коду
 * плана, поэтому состав планов должен совпасть: иначе коды сдвинулись бы и постановка попала бы в чужие окна.
 */
import type { ScenesFile, SceneShot } from '@shared/types';

/** Поля окна: их задаёт каркас, а не постановка. */
const WINDOW_FIELDS = ['original', 'start_frame', 'end_frame_exclusive'] as const;

export type SceneBoundsResult = { scenes: ScenesFile; changed: string[] } | { problem: string };

/** Число планов каждой части в порядке реестра. */
function partCounts(shots: SceneShot[]): Map<string, number> {
  const counts = new Map<string, number>();
  for (const shot of shots) counts.set(shot.sequence, (counts.get(shot.sequence) ?? 0) + 1);
  return counts;
}

/**
 * Реестр current с окнами каркаса scaffold. changed — коды планов, у которых сдвинулись границы или изменились строки
 * песни. Если части или число планов в них разошлись, возвращается объяснение вместо реестра.
 */
export function recalculateSceneBounds(current: ScenesFile, scaffold: ScenesFile): SceneBoundsResult {
  const sameShots =
    current.scenes.length === scaffold.scenes.length &&
    current.scenes.every((shot, index) => shot.id === scaffold.scenes[index].id && shot.sequence === scaffold.scenes[index].sequence);
  if (!sameShots) {
    const was = partCounts(current.scenes);
    const now = partCounts(scaffold.scenes);
    const parts = new Set([...was.keys(), ...now.keys()]);
    const sameParts = parts.size === was.size && parts.size === now.size;
    const differing = sameParts ? [...parts].find((part) => was.get(part) !== now.get(part)) : undefined;
    if (!differing) return { problem: scenarioTexts.notice.boundsPartsChanged };
    const title = scaffold.sequences.find((sequence) => sequence.id === differing)?.title || differing;
    return { problem: scenarioTexts.notice.boundsCountChanged({ part: title, was: was.get(differing) ?? 0, now: now.get(differing) ?? 0 }) };
  }
  const changed: string[] = [];
  const scenes = current.scenes.map((shot, index) => {
    const base = scaffold.scenes[index];
    if (WINDOW_FIELDS.every((key) => shot[key] === base[key])) return shot;
    changed.push(shot.id);
    return { ...shot, original: base.original, start_frame: base.start_frame, end_frame_exclusive: base.end_frame_exclusive };
  });
  const audioChanged = current.audio.end_seconds !== scaffold.audio.end_seconds;
  if (!changed.length && !audioChanged) return { scenes: current, changed };
  return { scenes: { ...current, audio: audioChanged ? { ...current.audio, end_seconds: scaffold.audio.end_seconds } : current.audio, scenes }, changed };
}
