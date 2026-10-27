import type { GlossaryEntry } from './glossary';

/** Поиск и подсветка используют одинаковое сравнение, сохраняя исходное написание в тексте. */
export function searchable(value: string): string {
  return value.toLocaleLowerCase('ru-RU').replace(/ё/g, 'е');
}

/** Каждое слово запроса может встретиться в названии, синонимах или самом объяснении. */
export function searchGlossary(entries: GlossaryEntry[], query: string): { words: string[]; entries: GlossaryEntry[] } {
  const words = searchable(query).trim().split(/\s+/).filter(Boolean);
  return {
    words,
    entries: entries.filter((entry) => {
      const text = searchable([entry.term, entry.category, ...entry.aliases, entry.description, entry.example ?? ''].join(' '));
      return words.every((word) => text.includes(word));
    })
  };
}
