/** Переходы между «Сценарием» и другими страницами по коду плана. */
import type { ScenesFile } from '@shared/types';

/** План из параметра ?shot=, если он есть в черновике реестра; иначе остаётся обычный выбор страницы. */
export function requestedShot(scenes: ScenesFile | null, shot: string | null): string | null {
  return shot && scenes?.scenes.some((item) => item.id === shot) ? shot : null;
}

/** Уход со страницы сбрасывает черновики: переход к другому плану недоступен, пока правки не сохранены. */
export function unsavedDraftsReason(treatmentDirty: boolean, scenesDirty: boolean): string | null {
  if (treatmentDirty && scenesDirty) return 'Сохраните трактовку и реестр сцен: при уходе со страницы несохранённые правки пропадут.';
  if (scenesDirty) return 'Сохраните реестр сцен: при уходе со страницы несохранённые правки пропадут.';
  if (treatmentDirty) return 'Сохраните трактовку: при уходе со страницы несохранённые правки пропадут.';
  return null;
}
