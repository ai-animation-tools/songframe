/** Проверка на слух меняет только свою служебную фразу, включая старые противоречивые записи. */
import { describe, expect, it } from 'vitest';
import type { TimingLine } from './types';
import { withTimingVerification } from './timing-verification';

const line: TimingLine = { id: 1, source_line: 2, start: 8, end: 12, verified: false };

describe('примечание проверки тайминга на слух', () => {
  it.each(['Совпали все 5 слов', 'Совпало 4 из 5 слов', 'Слова не распознаны, оценка по соседним строкам'])(
    'сохраняет оценку «%s» и возвращает автостатус при снятии подтверждения',
    (quality) => {
      const initial = { ...line, note: `${quality}; сверка на слух не выполнена.` };
      const confirmed = withTimingVerification(initial, true);
      expect(confirmed).toEqual({ ...initial, verified: true, note: `${quality}; сверка на слух выполнена.` });
      expect(withTimingVerification(confirmed, false)).toEqual(initial);
      expect(initial.verified).toBe(false);
    }
  );

  it('сохраняет ручные заметки до и после служебной фразы', () => {
    const initial = { ...line, note: 'Вход на вдохе; сверка на слух не выполнена. Проверить согласную; оставить паузу.' };
    expect(withTimingVerification(initial, true).note).toBe('Вход на вдохе; сверка на слух выполнена. Проверить согласную; оставить паузу.');
    expect(withTimingVerification({ ...line, note: 'добавлена вручную' }, true).note).toBe('добавлена вручную');
    expect(withTimingVerification({ ...line, note: 'Нужна сверка на слух не выполнена целиком.' }, true).note).toBe(
      'Нужна сверка на слух не выполнена целиком.'
    );
  });

  it('нормализует старые записи согласно verified и не добавляет заметку там, где её не было', () => {
    expect(withTimingVerification({ ...line, verified: true, note: 'Совпали все 5 слов; сверка на слух не выполнена.' }).note).toBe(
      'Совпали все 5 слов; сверка на слух выполнена.'
    );
    expect(withTimingVerification({ ...line, note: 'сверка на слух выполнена' }).note).toBe('сверка на слух не выполнена');
    expect(withTimingVerification({ ...line, note: 'подтверждено на слух' }, true).note).toBe('подтверждено на слух');
    expect(withTimingVerification({ ...line, note: '«сверка на слух не выполнена» — текст сообщения' }, true).note).toBe(
      '«сверка на слух не выполнена» — текст сообщения'
    );
    expect(withTimingVerification(line, true).note).toBeUndefined();
  });
});
