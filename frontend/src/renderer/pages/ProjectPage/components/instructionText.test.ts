/** Локальная правка textarea не должна переписывать переводы строк остальных инструкций. */
import { describe, expect, it } from 'vitest';
import { editInstructionText } from './instructionText';

describe('сохранение исходных переводов строк инструкций', () => {
  const previous = '  А\r\nБ\rВ\n  ';

  it('возвращает исходный текст, если DOM изменил только представление переводов строк', () => {
    expect(editInstructionText(previous, '  А\nБ\nВ\n  ')).toBe(previous);
  });

  it.each([
    ['добавление в начало', 'Начало\n  А\nБ\nВ\n  ', 'Начало\n  А\r\nБ\rВ\n  '],
    ['добавление в конец', '  А\nБ\nВ\n  X', '  А\r\nБ\rВ\n  X'],
    ['вставка в середину', '  А\nБ!\nВ\n  ', '  А\r\nБ!\rВ\n  '],
    ['замена текста', '  А\nНовая\nВ\n  ', '  А\r\nНовая\rВ\n  '],
    ['вставка новой строки', '  А\nБ\nНовая\nВ\n  ', '  А\r\nБ\rНовая\nВ\n  '],
    ['удаление CRLF', '  АБ\nВ\n  ', '  АБ\rВ\n  '],
    ['удаление CR', '  А\nБВ\n  ', '  А\r\nБВ\n  '],
    ['удаление LF', '  А\nБ\nВ  ', '  А\r\nБ\rВ  '],
    ['замена участка с переводами строк', '  А\nНовая\n  ', '  А\r\nНовая\n  '],
    ['очистка поля', '', '']
  ])('%s', (_name, value, expected) => {
    const result = editInstructionText(previous, value);
    expect(result).toBe(expected);
    expect(result.replace(/\r\n?/g, '\n')).toBe(value);
  });

  it('работает с пустой строкой, пробелами, Unicode и несколькими последовательными правками', () => {
    expect(editInstructionText('', '')).toBe('');
    expect(editInstructionText('', '  🦊\nЁ\t  ')).toBe('  🦊\nЁ\t  ');
    const unicode = '  🦊\r\nЁ\t\r尾\n  ';
    const first = editInstructionText(unicode, '  🦊!\nЁ\t\n尾\n  ');
    expect(first).toBe('  🦊!\r\nЁ\t\r尾\n  ');
    const second = editInstructionText(first, '  🦊!\nЁ\t\n\n尾\n  ');
    expect(second).toBe('  🦊!\r\nЁ\t\r\n\n尾\n  ');
    expect(second.replace(/\r\n?/g, '\n')).toBe('  🦊!\nЁ\t\n\n尾\n  ');
  });

  it('не склеивает CR и LF после удаления текста между ними', () => {
    const result = editInstructionText('А\rтекст\nБ', 'А\n\nБ');
    expect(result).toBe('А\r\n\nБ');
    expect(result.replace(/\r\n?/g, '\n')).toBe('А\n\nБ');
  });
});
