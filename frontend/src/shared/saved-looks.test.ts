import { describe, expect, it } from 'vitest';
import { defaultSavedLookKind, defaultSavedLookName, savedLookNameLength, savedLookState, type SavedLookRules, type SavedLooksView } from './saved-looks';

const rules: SavedLookRules = { nameMaxChars: 5, extraMin: 1, extraMax: 3, kinds: ['character', 'prop', 'costume'], coverFixed: true };

describe('сохранённые образы', () => {
  it('берёт статус референса из отчёта, без отчёта или поддержки — null', () => {
    const view: SavedLooksView = {
      supported: true,
      provider: 'test',
      rules,
      report: { account: 'a', count: 1, states: [{ reference: 'hero', status: 'ready', look: '1', name: 'Герой' }], looks: [] },
      error: ''
    };
    expect(savedLookState(view, 'hero')?.status).toBe('ready');
    expect(savedLookState(view, 'cup')).toEqual({ reference: 'cup', status: 'none' });
    expect(savedLookState({ ...view, report: null, error: 'Нет входа.' }, 'hero')).toBeNull();
    expect(savedLookState({ ...view, supported: false }, 'hero')).toBeNull();
    expect(savedLookState(null, 'hero')).toBeNull();
  });

  it('вид по умолчанию — вид референса, если провайдер его хранит, иначе первый', () => {
    expect(defaultSavedLookKind('prop', rules)).toBe('prop');
    expect(defaultSavedLookKind('style', rules)).toBe('character');
  });

  it('имя по умолчанию укорачивается по символам, а не по единицам UTF-16', () => {
    expect(defaultSavedLookName('  Мальчик в плаще ', rules)).toBe('Мальчи'.slice(0, 5));
    expect(defaultSavedLookName('🙂🙂🙂🙂🙂🙂', rules)).toBe('🙂🙂🙂🙂🙂');
    expect(savedLookNameLength(' 🙂я ')).toBe(2);
  });
});
