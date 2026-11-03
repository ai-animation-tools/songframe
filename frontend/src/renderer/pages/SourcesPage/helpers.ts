/** Преобразования локальной формы: коды, ключи и сравнение сохранённых значений. */
import type { ReferenceForm } from './types';

let keyCounter = 1;
export const nextKey = (): number => keyCounter++;

/** Допустимый код референса; совпадает с проверкой сохранения в главном процессе. */
export const ID_PATTERN = /^[a-z][a-z0-9_]*$/;

export { AUDIO_FILTER, IMAGE_FILTER, TEXT_FILTER } from '../../file-filters';

/** Код референса из названия: транслитерация кириллицы в латиницу, остальное в подчёркивание. */
export function suggestId(name: string): string {
  const map: Record<string, string> = {
    а: 'a',
    б: 'b',
    в: 'v',
    г: 'g',
    д: 'd',
    е: 'e',
    ё: 'e',
    ж: 'zh',
    з: 'z',
    и: 'i',
    й: 'y',
    к: 'k',
    л: 'l',
    м: 'm',
    н: 'n',
    о: 'o',
    п: 'p',
    р: 'r',
    с: 's',
    т: 't',
    у: 'u',
    ф: 'f',
    х: 'h',
    ц: 'ts',
    ч: 'ch',
    ш: 'sh',
    щ: 'sch',
    ъ: '',
    ы: 'y',
    ь: '',
    э: 'e',
    ю: 'yu',
    я: 'ya'
  };
  const latin = name
    .toLowerCase()
    .split('')
    .map((ch) => map[ch] ?? ch)
    .join('');
  return latin
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^[^a-z]+/, '')
    .replace(/_+$/, '');
}

export function stripKeys(ref: ReferenceForm): unknown {
  return {
    id: ref.id,
    kind: ref.kind,
    name: ref.name,
    short_name: ref.short_name,
    description: ref.description,
    prompt: ref.prompt,
    files: ref.files.map((f) => ({ path: f.sourcePath ?? f.existingPath, view: f.view, note: f.note, prompt: f.prompt }))
  };
}
