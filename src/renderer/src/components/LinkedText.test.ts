/** Отсылки «на странице «…»» и «в блоке «…»» становятся ссылками с маршрутом и якорем цели; прочие кавычки остаются текстом. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { LinkedText } from './LinkedText';
import { ANCHORS, linkLocation, linkSegments } from './linkTargets';
import { NAV_PAGES } from '../navigation';

const render = (text: string, at = '/project', renderText?: (value: string) => string): string =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: [at] }, createElement(LinkedText, { text, renderText })));
const links = (html: string): Array<{ href: string; text: string }> =>
  [...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((match) => ({ href: match[1].replace(/&amp;/g, '&'), text: match[2] }));

let restoreProvider: () => void;
beforeAll(() => {
  restoreProvider = registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo);
});
afterAll(() => restoreProvider());

describe('LinkedText', () => {
  it('делает ссылкой название страницы из навигации и сохраняет кавычки в тексте ссылки', () => {
    const html = render('Сначала добавьте текст песни на странице «Исходники».');
    expect(links(html)).toEqual([{ href: '/project/sources', text: '«Исходники»' }]);
    expect(html).toContain('Сначала добавьте текст песни на странице ');
    expect(html.endsWith('</a>.')).toBe(true);
  });

  it('берёт маршруты из общей таблицы навигации', () => {
    for (const page of NAV_PAGES) {
      expect(links(render(`Откройте страницу «${page.label}».`, '/elsewhere'))).toEqual([{ href: page.to, text: `«${page.label}»` }]);
    }
  });

  it('понимает падежные формы названий страниц', () => {
    expect(links(render('Подробности — в «Журнале заданий», модель — в «Таймингах».')).map((link) => link.href)).toEqual(['/jobs', '/project/timing']);
  });

  it('ведёт к известному блоку с якорем', () => {
    expect(links(render('Речевой план: сначала подготовьте WAV речи в блоке «Речь».'))).toEqual([
      { href: `/project/production?anchor=${ANCHORS.productionSpeech}`, text: '«Речь»' }
    ]);
    expect(links(render('Запуск — в блоке «Подготовка плана».'))[0].href).toBe(`/project/production?anchor=${ANCHORS.productionWorkflow}`);
  });

  it('на той же странице сохраняет её параметры и добавляет якорь', () => {
    const html = render('Подготовьте WAV в блоке «Речь».', '/project/production?shot=M01');
    expect(links(html)[0].href).toBe(`/project/production?shot=M01&anchor=${ANCHORS.productionSpeech}`);
  });

  it('оставляет текстом кавычки без цели и ссылку на текущую страницу без якоря', () => {
    expect(links(render('Нажмите «Сохранить», затем «Ещё».'))).toEqual([]);
    expect(links(render('Создайте сценарий на странице «Сценарий».', '/project/scenario'))).toEqual([]);
    expect(render('Обычный текст без отсылок.')).toBe('Обычный текст без отсылок.');
  });

  it('ведёт к строке провайдера на странице «Среда», если он назван в том же предложении', () => {
    expect(links(render(`Войдите в ${testProviderInfo.title} на странице «Среда».`))[0].href).toBe(`/environment?anchor=${TEST_PROVIDER}`);
    // Провайдер из соседнего предложения не определяет строку.
    expect(links(render(`${testProviderInfo.title} доступен. Укажите папку на странице «Среда».`))[0].href).toBe('/environment');
    // Сокращение «См.» не разрывает предложение.
    expect(links(render('Python не найден: проверки недоступны. См. страницу «Среда».'))[0].href).toBe('/environment?anchor=python');
  });

  it('оформляет части текста и ссылки переданной функцией', () => {
    const html = render('Откройте «Сцены» сейчас', '/project', (value) => value.toUpperCase());
    expect(links(html)).toEqual([{ href: '/project/scenes', text: '«СЦЕНЫ»' }]);
    expect(html).toContain('ОТКРОЙТЕ ');
  });
});

describe('linkSegments и linkLocation', () => {
  it('делит текст на части без потерь', () => {
    const text = 'Проверьте «Тайминги» и «Кастинг», затем нажмите «Создать трактовку».';
    const segments = linkSegments(text, '/project');
    expect(segments.map((segment) => segment.text).join('')).toBe(text);
    expect(segments.filter((segment) => segment.target).map((segment) => segment.target?.path)).toEqual(['/project/timing', '/project/cast']);
  });

  it('заменяет прежний якорь и не переносит параметры другой страницы', () => {
    expect(linkLocation({ path: '/project/production', anchor: 'a' }, { pathname: '/project/production', search: '?shot=M01&anchor=b' })).toEqual({
      pathname: '/project/production',
      search: '?shot=M01&anchor=a'
    });
    expect(linkLocation({ path: '/environment' }, { pathname: '/project/scenes', search: '?shot=M01' })).toEqual({ pathname: '/environment', search: '' });
  });
});
