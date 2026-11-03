import { describe, expect, it } from 'vitest';
import { referenceImageOption } from './referenceImageOptions';

describe('нейтральные опоры исходников и кастинга', () => {
  it('оставляет примечание отдельным от подписи вида', () => {
    expect(referenceImageOption({ path: '/image.png', view: 'front', note: '  Сохранить лицо  ' })).toEqual({
      path: '/image.png',
      label: 'Спереди',
      note: 'Сохранить лицо'
    });
  });

  it('не передаёт пустое примечание и использует нейтральный вид для файла без метаданных', () => {
    expect(referenceImageOption({ path: '/image.png', note: ' \n ' })).toEqual({ path: '/image.png', label: 'Другое' });
  });

  it('не различает страницы и допускает одинаковые подписи разных файлов', () => {
    const options = ['/first.png', '/second.png'].map((path) => referenceImageOption({ path, view: 'side', note: 'Контур' }));
    expect(options.map((option) => option.label)).toEqual(['Сбоку', 'Сбоку']);
    expect(options.map((option) => option.path)).toEqual(['/first.png', '/second.png']);
  });
});
