import { describe, expect, it } from 'vitest';
import { SEARCH_QUERY_LIMIT, fieldEditCommand, googleSearchUrl, needsFieldUndo, textFieldActions, type TextFieldState } from './textContextMenu';

const state = (overrides: Partial<TextFieldState>): TextFieldState => ({
  start: 0,
  end: 0,
  selected: '',
  editable: true,
  secret: false,
  empty: false,
  ...overrides
});

// Поля и выделение в браузере проверяет история «Общие/Контекстное меню текста».
describe('контекстное меню текста', () => {
  it('доступность пунктов следует выделению, правке и паролю', () => {
    expect(textFieldActions(state({ selected: 'строка' }))).toEqual({ cut: true, copy: true, paste: true, selectAll: true });
    expect(textFieldActions(state({}))).toEqual({ cut: false, copy: false, paste: true, selectAll: true });
    expect(textFieldActions(state({ selected: 'путь', editable: false }))).toEqual({ cut: false, copy: true, paste: false, selectAll: true });
    expect(textFieldActions(state({ selected: 'ключ', secret: true }))).toEqual({ cut: false, copy: false, paste: true, selectAll: true });
    expect(textFieldActions(state({ empty: true }))).toMatchObject({ selectAll: false });
  });

  it('строит адрес поиска из выделения', () => {
    const query = (text: string) => new URL(googleSearchUrl(text)!).searchParams.get('q');
    expect(googleSearchUrl('дорога')).toBe('https://www.google.com/search?q=%D0%B4%D0%BE%D1%80%D0%BE%D0%B3%D0%B0');
    expect(query('  дорога  к\nстарым   воротам ')).toBe('дорога к старым воротам');
    expect(googleSearchUrl('a&b=c#d')).toBe('https://www.google.com/search?q=a%26b%3Dc%23d');
    expect(googleSearchUrl(' \n ')).toBeNull();
    expect(query('я'.repeat(SEARCH_QUERY_LIMIT + 20))).toHaveLength(SEARCH_QUERY_LIMIT);
  });
});

describe('отмена в полях', () => {
  const keys = (code: string, modifiers: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {}) => ({
    code,
    ctrlKey: true,
    shiftKey: false,
    altKey: false,
    metaKey: false,
    ...modifiers
  });

  it('команда по физической клавише в любой раскладке', () => {
    expect(fieldEditCommand(keys('KeyZ'))).toBe('undo');
    expect(fieldEditCommand(keys('KeyZ', { shiftKey: true }))).toBe('redo');
    expect(fieldEditCommand(keys('KeyY'))).toBe('redo');
    expect(fieldEditCommand(keys('KeyY', { shiftKey: true }))).toBeNull();
    expect(fieldEditCommand(keys('KeyZ', { ctrlKey: false }))).toBeNull();
    expect(fieldEditCommand(keys('KeyZ', { altKey: true }))).toBeNull();
    expect(fieldEditCommand(keys('KeyX'))).toBeNull();
  });

  it('своя отмена только в Linux', () => {
    expect(needsFieldUndo('Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15')).toBe(true);
    expect(needsFieldUndo('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0 Safari/537.36 Edg/130.0')).toBe(false);
  });
});
