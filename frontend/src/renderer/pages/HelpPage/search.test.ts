import { describe, expect, it } from 'vitest';
import { GLOSSARY, type GlossaryEntry } from './glossary';
import { searchGlossary } from './search';

const examples: GlossaryEntry[] = [
  { id: 'one', term: 'Приёмка', category: 'Работа', aliases: ['готовый клип'], description: 'Решение после просмотра', example: 'Выбранный результат' },
  { id: 'two', term: 'Проект', category: 'Работа', aliases: ['клип'], description: 'Папка с файлами' }
];

describe('поиск по справке', () => {
  it('сопоставляет регистр, ё и несколько слов в разных полях', () => {
    expect(searchGlossary(examples, ' ПРИЕМКА  результат ').entries.map((entry) => entry.id)).toEqual(['one']);
  });

  it('находит синонимы и возвращает всё при пустом запросе', () => {
    expect(searchGlossary(examples, 'готовый клип').entries.map((entry) => entry.id)).toEqual(['one']);
    expect(searchGlossary(examples, '  ').entries).toEqual(examples);
    expect(searchGlossary(examples, 'несуществующее слово').entries).toEqual([]);
  });

  it('находит практические ответы по вопросам новичка', () => {
    for (const query of ['с чего начать', 'как перенести проект', 'почему кнопка недоступна', 'стоимость']) {
      expect(searchGlossary(GLOSSARY, query).entries.length, query).toBeGreaterThan(0);
    }
  });

  it('объясняет статус изменённой постановки и сохранение без производства', () => {
    for (const query of ['постановка изменена', 'сохранить без производства', 'опечатка в реестре']) {
      expect(
        searchGlossary(GLOSSARY, query).entries.map((entry) => entry.id),
        query
      ).toContain('staging-changed');
    }
  });

  it('объясняет словарь свойств и откуда берутся варианты значений', () => {
    for (const query of ['словарь свойств', 'откуда варианты', 'выпадающий список', 'своё свойство код', 'шаблон проверки']) {
      expect(
        searchGlossary(GLOSSARY, query).entries.map((entry) => entry.id),
        query
      ).toContain('property-dictionary');
    }
  });

  it('находит нужные инструкции по естественным вопросам о монтаже', () => {
    const queries: Record<string, string> = {
      'переход между сценами': 'montage-cut-preview',
      'проверить склейку': 'montage-cut-preview',
      'попасть в слова': 'montage-lyrics-snap',
      'привязка стыка': 'montage-lyrics-snap',
      'увеличить дорожку': 'montage-layout',
      'плеер на втором мониторе': 'montage-layout',
      'заменить текущий': 'montage-materials',
      'полный оригинал': 'montage-materials',
      'почему не применить монтаж': 'montage-save-apply',
      'экспортировать mp4': 'montage-save-apply'
    };
    for (const [query, id] of Object.entries(queries)) {
      expect(
        searchGlossary(GLOSSARY, query).entries.map((entry) => entry.id),
        query
      ).toContain(id);
    }
  });
});
