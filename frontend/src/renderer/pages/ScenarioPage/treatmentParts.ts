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
 * Отличие от 634fd94: оригинал копировал границы секций как есть, и сразу после построения части
 * не стыковались. Теперь после сортировки по началу первая часть начинается с 0, конец каждой
 * части — начало следующей (промежутки закрываются, перекрытия снимаются), последняя заканчивается
 * на длительности трека (без известной длительности — на конце своей секции). Секции с одинаковым
 * началом дают часть нулевой длины: такую проблему покажет проверка трактовки, а не скроет построение.
 * Липсинк по умолчанию выключен у всех частей, как у части, добавленной вручную: решение «поют в
 * кадре» принимает человек. Отличие от 634fd94: оригинал включал его у всех частей, кроме
 * вступления и проигрышей, в том числе у неразмеченных.
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
