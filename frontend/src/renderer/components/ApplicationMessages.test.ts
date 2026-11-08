/** Проверяет показ сообщений Go в renderer без изменения маршрутов и экранирования. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { applicationTexts } from '@shared/texts/application';
import { LinkedText } from './LinkedText';

const renderMessage = (text: string): string =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/project/production'] }, createElement(LinkedText, { text })));

describe('сообщения приложения в интерфейсе', () => {
  it('ведёт предупреждение о сценарии на страницу сценария', () => {
    const scenario = renderMessage(applicationTexts.scenarioReviewRequired);
    expect(scenario).toContain('href="/project/scenario"');
    expect(scenario).toContain('«Сценарий»</a>.');
  });

  it('сохраняет ссылку на исходники и безопасный вывод диагностики', () => {
    const lyrics = renderMessage(applicationTexts.lyricsInvalid({ problems: ['<script> & {problems}'] }));
    expect(lyrics).toContain('href="/project/sources"');
    expect(lyrics).toContain('«Исходники»</a>: &lt;script&gt; &amp; {problems}');
    expect(lyrics).not.toContain('<script>');
  });
});
