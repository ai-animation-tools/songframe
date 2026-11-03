/** Проверяет счётчики и смешанные подписи справки, сохраняя статьи и отсылки у прежнего владельца. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { helpTexts } from '@shared/texts/help';
import { GlossaryItem } from './components/GlossaryItem';
import type { GlossaryEntry } from './glossary';

it.each([0, 1, 2, 5, 11, 21, -2, 1.5])('сохраняет прежнюю фразу счётчиков для %s', (count) => {
  expect(helpTexts.found({ count, total: 74 })).toBe(`Найдено статей: ${count} из 74`);
  expect(helpTexts.found({ count: 0, total: count })).toBe(`Найдено статей: 0 из ${count}`);
  expect(helpTexts.total(count)).toBe(`Всего статей: ${count}`);
});

describe('Обвязка статьи справки', () => {
  const entry: GlossaryEntry = {
    id: 'fixture',
    term: 'Название <&>',
    category: 'Тест',
    aliases: ['секрет <b>'],
    description: 'Проверьте на странице «Проекты».',
    example: 'Откройте страницу «Среда».'
  };
  const render = (words: string[], article: GlossaryEntry = entry): string =>
    renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/help'] }, createElement(GlossaryItem, { entry: article, words })));

  it('сохраняет пробелы целых фраз, ссылки и безопасную подсветку синонима', () => {
    const html = render(['секрет']);
    const plain = html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, '');
    expect(plain).toBe('Название &lt;&amp;&gt;Также называется: секрет &lt;b&gt;Проверьте на странице «Проекты».Например: Откройте страницу «Среда».');
    expect([...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((match) => [match[1], match[2]])).toEqual([
      ['/projects', '«Проекты»'],
      ['/environment', '«Среда»']
    ]);
    expect(html).not.toContain('<b>');
  });

  it.each([undefined, ''])('не добавляет фразу примера для пустого значения %s', (example) => {
    const html = render([], { ...entry, example });
    expect(html).not.toContain('Также называется:');
    expect(html).not.toContain('Например:');
  });

  it('не разбирает повторно имена слотов внутри синонима и примера', () => {
    const html = render(['секрет'], { ...entry, aliases: ['секрет {aliases} <b>'], example: 'Значение {example} & <i>.' });
    const plain = html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, '');
    expect(plain).toBe(
      'Название &lt;&amp;&gt;Также называется: секрет {aliases} &lt;b&gt;Проверьте на странице «Проекты».Например: Значение {example} &amp; &lt;i&gt;.'
    );
    expect(html).not.toContain('<i>');
  });

  it('скрывает подпись синонимов без совпадения и оставляет пример дословно', () => {
    const html = render([]);
    expect(html).not.toContain('Также называется:');
    expect(html).toContain('Например: ');
    expect(helpTexts.description).toBe('Как начать работу над клипом и что означают действия в приложении. Ищите по названию, вопросу или знакомым словам.');
  });
});
