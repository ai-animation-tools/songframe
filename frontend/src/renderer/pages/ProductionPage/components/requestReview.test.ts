import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { RequestParameters } from './RequestParameters';
import { RequestPrompt } from './RequestPrompt';

describe('Просмотр подтверждаемого запроса', () => {
  it('показывает промпт абзацами в отдельном подписанном блоке без редактирования', () => {
    const path = `Путь/${'длинное_имя'.repeat(40)}`;
    const text = `  Первый абзац.\n\n${path}  \nПоследняя строка.\n`;
    const html = renderToStaticMarkup(createElement(RequestPrompt, { text }));
    expect(html).toContain('Промпт запроса');
    expect(html).toContain('Первый абзац.');
    expect(html).toContain(path);
    expect(html).toContain('Последняя строка.');
    expect(html).not.toContain('<pre');
    expect(html).toMatch(/<div[^>]*tabindex="0"[^>]*aria-labelledby=/);
    expect(html).not.toMatch(/<textarea|<input|contenteditable/i);
  });

  it('показывает вложенные параметры по строкам таблицы человекочитаемо, без JSON', () => {
    const parameters = { duration: 5, audio: false, custom: null, resolution: '1080p', nested: { path: 'inputs/' + 'long-path'.repeat(40), frames: [1, 2] } };
    const html = renderToStaticMarkup(createElement(RequestParameters, { parameters }));
    expect(html).toContain('Параметры запроса');
    expect(html).toContain('<table');
    expect(html.match(/scope="row"/g)).toHaveLength(5);
    expect(html).toContain('>5</p>');
    expect(html).toContain('>Нет</p>');
    expect(html).toContain('>—</p>');
    expect(html).toContain('<span>1080p</span>');
    expect(html).toContain('Файл:');
    expect(html).toContain(parameters.nested.path);
    expect(html).toContain('frames:');
    const markup = html.replace(/<style[^>]*>[^<]*<\/style>/g, '');
    expect(markup).not.toContain('{');
    expect(markup).not.toContain('&quot;path&quot;');
  });

  it('явно сообщает об отсутствии дополнительных параметров', () => {
    const html = renderToStaticMarkup(createElement(RequestParameters, { parameters: {} }));
    expect(html).toContain('Дополнительные параметры не заданы.');
    expect(html).not.toContain('<table');
  });
});
