import { describe, expect, it } from 'vitest';
import { countLabel, plural } from './plural';

describe('plural', () => {
  it('согласует число по правилам русского языка', () => {
    const word = (n: number): string => plural(n, 'кадр', 'кадра', 'кадров');
    expect([1, 2, 4, 5, 11, 12, 14, 21, 22, 25, 101, 111, 222].map(word)).toEqual([
      'кадр',
      'кадра',
      'кадра',
      'кадров',
      'кадров',
      'кадров',
      'кадров',
      'кадр',
      'кадра',
      'кадров',
      'кадр',
      'кадров',
      'кадра'
    ]);
    expect(plural(2.5, 'кредит', 'кредита', 'кредитов')).toBe('кредита');
    expect(countLabel(24, 'кредит', 'кредита', 'кредитов')).toBe('24 кредита');
  });
});
