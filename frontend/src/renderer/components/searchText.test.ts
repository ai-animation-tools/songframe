import { describe, expect, it } from 'vitest';
import { matchesWords, searchWords } from './searchText';

describe('живой поиск', () => {
  it('не зависит от регистра и «ё», требует все слова в любом порядке', () => {
    const words = searchWords('  Ёлка   м13 ');
    expect(words).toEqual(['елка', 'м13']);
    expect(matchesWords('М13 · ёлка у дороги', words)).toBe(true);
    expect(matchesWords('М13 · сосна', words)).toBe(false);
    expect(searchWords('')).toEqual([]);
  });
});
