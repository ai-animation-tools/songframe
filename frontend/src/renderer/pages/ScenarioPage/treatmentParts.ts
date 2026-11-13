import type { TimingSection, TreatmentSequence } from '@shared/types';

/** Округление границы до миллисекунд, как при сохранении трактовки. */
function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}

/** Код части по названию секции разметки: латиница для известных частей песни и уникальный суффикс при повторе. */
function partCodes(): (name: string, index: number) => string {
  const used = new Set<string>();
  return (name, index) => {
    const lower = name.toLowerCase();
    // eslint-disable-next-line no-restricted-syntax -- Подстрока исходного названия части определяет сохраняемый ID, а не подпись интерфейса.
    const base = lower.includes('припев')
      ? 'chorus'
      : // eslint-disable-next-line no-restricted-syntax -- Подстрока исходного названия части определяет сохраняемый ID, а не подпись интерфейса.
        lower.includes('куплет')
        ? 'verse'
        : // eslint-disable-next-line no-restricted-syntax -- Подстрока исходного названия части определяет сохраняемый ID, а не подпись интерфейса.
          lower.includes('вступ')
          ? 'intro'
          : // eslint-disable-next-line no-restricted-syntax -- Подстрока исходного названия части определяет сохраняемый ID, а не подпись интерфейса.
            lower.includes('финал')
            ? 'final'
            : // eslint-disable-next-line no-restricted-syntax -- Подстрока исходного названия части определяет сохраняемый ID, а не подпись интерфейса.
              lower.includes('проигрыш')
              ? 'bridge'
              : `part${index + 1}`;
    let candidate = base;
    let n = 2;
    while (used.has(candidate)) candidate = `${base}_${n++}`;
    used.add(candidate);
    return candidate;
  };
}

/**
 * Части трактовки из музыкальной карты timing.json. Секции карты могут перекрываться, а промежутки
 * короче порога в ней не заполнены, тогда как трактовка требует частей встык от 0 до конца трека.
 * Поэтому после сортировки по началу первая часть начинается с 0, конец каждой
 * части — начало следующей (промежутки закрываются, перекрытия снимаются), последняя заканчивается
 * на длительности трека (без известной длительности — на конце своей секции). Секции с одинаковым
 * началом дают часть нулевой длины: такую проблему покажет проверка трактовки, а не скроет построение.
 * Липсинк по умолчанию выключен у всех частей, как у части, добавленной вручную: решение «поют в
 * кадре» принимает человек.
 * timing.json не меняется.
 */
export function partsFromSections(sections: TimingSection[], duration: number | null): TreatmentSequence[] {
  const sorted = [...sections].sort((a, b) => a.start - b.start);
  const code = partCodes();
  return sorted.map((section, index) => {
    const next = sorted[index + 1];
    const end = next ? next.start : duration && duration > 0 ? duration : section.end;
    return {
      id: code(section.name, index),
      title: section.name,
      direction: '',
      start: index === 0 ? 0 : round(section.start),
      end: round(end),
      entities: [],
      lipsync: false,
      max_shot_seconds: 6
    };
  });
}

/**
 * Правка одной части трактовки с сохранением стыка: части идут встык, поэтому новое начало части становится и концом
 * предыдущей, а новый конец — началом следующей. Соседи берутся по порядку в списке: в нём части показаны и в нём их
 * строят «Части из разметки». Начало первой части и конец последней соседей не имеют и меняются только сами.
 */
export function patchTreatmentPart(sequences: TreatmentSequence[], index: number, patch: Partial<TreatmentSequence>): TreatmentSequence[] {
  return sequences.map((part, position) => {
    if (position === index) return { ...part, ...patch };
    if (patch.start !== undefined && position === index - 1) return { ...part, end: patch.start };
    if (patch.end !== undefined && position === index + 1) return { ...part, start: patch.end };
    return part;
  });
}
