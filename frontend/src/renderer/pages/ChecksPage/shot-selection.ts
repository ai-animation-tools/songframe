/** Начало диапазона задаёт обычный щелчок; Shift добавляет сцены в порядке сценария, включая дробные номера. */
export interface ShotSelection {
  selected: string[];
  anchor: string | null;
}

export function selectShot(previous: ShotSelection, order: string[], id: string, extend: boolean): ShotSelection {
  const end = order.indexOf(id);
  if (end === -1) return previous;
  const start = previous.anchor === null ? -1 : order.indexOf(previous.anchor);
  const selected = new Set(previous.selected);
  if (extend && start !== -1) {
    for (const shot of order.slice(Math.min(start, end), Math.max(start, end) + 1)) selected.add(shot);
  } else if (selected.has(id)) {
    selected.delete(id);
  } else {
    selected.add(id);
  }
  return { selected: order.filter((shot) => selected.has(shot)), anchor: extend && start !== -1 ? previous.anchor : id };
}
