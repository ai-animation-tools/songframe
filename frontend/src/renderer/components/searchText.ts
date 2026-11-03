/** Живой поиск по спискам: регистр и «ё» не мешают, все слова запроса должны найтись. */
export function normalizeSearch(text: string): string {
  // eslint-disable-next-line no-restricted-syntax -- Буквы задают техническую нормализацию поиска, это не подписи интерфейса.
  return text.toLocaleLowerCase('ru').replaceAll('ё', 'е');
}

export function searchWords(query: string): string[] {
  return normalizeSearch(query).split(/\s+/).filter(Boolean);
}

export function matchesWords(text: string, words: string[]): boolean {
  const normalized = normalizeSearch(text);
  return words.every((word) => normalized.includes(word));
}
