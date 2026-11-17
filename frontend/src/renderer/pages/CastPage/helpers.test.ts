import { describe, expect, it } from 'vitest';
import { noteLabel, referenceFileLabels } from './helpers';

// Те же случаи, что TestFileLabels и TestNoteLabel в internal/sources: карточка кастинга и отчёт
// проверки сценария называют изображение одинаково.
describe('подписи изображений референса', () => {
  const long = 'Общий план перед столкновением. Мальчик делает первый шаг с тротуара на дорогу.';
  it('одно изображение — имя', () => expect(referenceFileLabels('Вход', [{ view: 'other', note: 'Вход' }])).toEqual(['Вход']));
  it('разные виды', () => expect(referenceFileLabels('Артём', [{ view: 'face' }, { view: 'full' }])).toEqual(['Артём — Лицо', 'Артём — В полный рост']));
  it('совпавший вид — заметка', () =>
    expect(referenceFileLabels('Артём', [{ view: 'other', note: 'закрыта' }, { view: 'other' }])).toEqual(['Артём — закрыта', 'Артём — Другое']));
  it('совпавшее начало заметки — номер', () =>
    expect(referenceFileLabels('Артём', [{ view: 'other', note: long }, { view: 'other', note: long }, { view: 'side' }])).toEqual([
      'Артём — Общий план перед столкновением (1)',
      'Артём — Общий план перед столкновением (2)',
      'Артём — Сбоку'
    ]));
  it('начало заметки', () => {
    expect(noteLabel('  пустой ракурс ')).toBe('пустой ракурс');
    expect(noteLabel('Столкновение осталось вне кадра. Мальчик')).toBe('Столкновение осталось вне кадра');
    expect(noteLabel('Рабочий на заводе которого спасают при пожаре')).toBe('Рабочий на заводе которого спасают при');
    expect(noteLabel('')).toBe('');
  });
});
