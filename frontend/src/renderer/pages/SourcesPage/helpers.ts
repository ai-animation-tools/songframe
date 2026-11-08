/** Преобразования локальной формы: коды, ключи и сравнение сохранённых значений. */
import { sourcesTexts } from '@shared/texts/sources';
import type { ReferenceKind, SourceKind } from '@shared/types';
import type { ReferenceForm } from './types';

let keyCounter = 1;
export const nextKey = (): number => keyCounter++;

/** Допустимый код референса; совпадает с проверкой сохранения в Go. */
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

/**
 * Тип нового референса по коду: если в кастинге есть сущность с этим кодом и её тип есть в списке, референс берёт его,
 * чтобы изображения сразу легли в папку нужного типа. Сохранённый референс (с файлами описи) тип не меняет.
 */
export function kindForId(reference: ReferenceForm, id: string, entityKinds: Record<string, string>, kinds: SourceKind[]): ReferenceKind {
  if (reference.files.some((file) => file.existingPath)) return reference.kind;
  const kind = entityKinds[id];
  return kind && kinds.some((item) => item.id === kind) ? kind : reference.kind;
}

/**
 * Что сохранение сделает с файлами референса, если тип сменили: перенесёт сохранённые изображения в папку нового типа
 * или оставит их на месте, когда референс используют планы с готовыми материалами (pinnedShots). null — тип не менялся
 * или все изображения уже в папке типа.
 */
export function kindChangeNotice(reference: ReferenceForm, kinds: SourceKind[], pinnedShots: string[] | undefined): string | null {
  if (reference.savedKind === undefined || reference.savedKind === reference.kind) return null;
  const dir = kinds.find((item) => item.id === reference.kind)?.dir;
  const folder = (path: string): string => path.slice(0, Math.max(path.lastIndexOf('/'), 0));
  const misplaced = reference.files.find((file) => file.existingPath && folder(file.existingPath) !== dir);
  if (!dir || !misplaced?.existingPath) return null;
  const current = folder(misplaced.existingPath);
  return pinnedShots ? sourcesTexts.kindKeepsFiles({ dir: current, shots: pinnedShots }) : sourcesTexts.kindMovesFiles({ dir });
}
