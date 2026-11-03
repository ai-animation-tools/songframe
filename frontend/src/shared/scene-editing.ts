import type { SceneShot, StateFrom } from './types';

/** Ссылки на удаляемый план сначала переводим на объединённый, затем меняем номера. */
export function renumberShots(list: SceneShot[], aliases = new Map<string, string>()): SceneShot[] {
  const mapping = new Map(list.map((shot, index) => [shot.id, `M${String(index + 1).padStart(2, '0')}`]));
  const target = (id: string): string => mapping.get(aliases.get(id) ?? id) ?? id;
  const remap = (from: StateFrom): StateFrom => (typeof from === 'string' ? target(from) : from ? { ...from, scene: target(from.scene) } : from);
  // Источник производного плана переименовывается вместе с планами, как и источник состояния.
  return list.map((shot) => ({
    ...shot,
    id: mapping.get(shot.id)!,
    state_from: remap(shot.state_from),
    ...(shot.derived_from ? { derived_from: { shot: target(shot.derived_from.shot) } } : {})
  }));
}
