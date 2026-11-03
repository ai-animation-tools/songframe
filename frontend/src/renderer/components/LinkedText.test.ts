/** Отсылки «на странице «…»» и «в блоке «…»» становятся ссылками с маршрутом и якорем цели; прочие кавычки остаются текстом. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { LinkedText } from './LinkedText';
import { linkLocation, linkSegments } from './linkTargets';

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

  // Ожидания независимы от словаря и таблиц целей: перенос не должен менять существующие названия и переходы.
  it.each([
    ['Проекты', '/projects'],
    ['Проект', '/project'],
    ['Исходники', '/project/sources'],
    ['Тайминги', '/project/timing'],
    ['Кастинг', '/project/cast'],
    ['Сценарий', '/project/scenario'],
    ['Производство', '/project/production'],
    ['Сцены', '/project/scenes'],
    ['Монтаж пробы', '/project/montage'],
    ['Проверки', '/project/checks'],
    ['Аниматик', '/project/animatic'],
    ['Журнал заданий', '/jobs'],
    ['Среда', '/environment'],
    ['Настройки', '/settings'],
    ['Справка', '/help']
  ])('сохраняет название страницы «%s» и маршрут %s', (name, href) => {
    expect(links(render(`Откройте страницу «${name}».`, '/elsewhere'))).toEqual([{ href, text: `«${name}»` }]);
  });

  it.each([
    ['Исходниках', '/project/sources'],
    ['Таймингах', '/project/timing'],
    ['Таймингов', '/project/timing'],
    ['Кастинге', '/project/cast'],
    ['Сценарии', '/project/scenario'],
    ['Производстве', '/project/production'],
    ['Проверках', '/project/checks'],
    ['Аниматике', '/project/animatic'],
    ['Журнале заданий', '/jobs'],
    ['Среде', '/environment'],
    ['Настройках', '/settings'],
    ['Справке', '/help']
  ])('понимает падежную форму «%s» и ведёт на %s', (name, href) => {
    expect(links(render(`Подробности — в «${name}».`, '/elsewhere'))).toEqual([{ href, text: `«${name}»` }]);
  });

  it.each([
    ['Подготовка плана', '/project/production?anchor=production-workflow'],
    ['Речь', '/project/production?anchor=production-speech'],
    ['Речь (липсинк)', '/project/production?anchor=production-speech'],
    ['Очередь', '/project/production?anchor=production-filter'],
    ['Проверки проекта', '/project/checks?anchor=checks-project'],
    ['Проба стыков', '/project/checks?anchor=checks-review'],
    ['Генерация видео', '/project?anchor=project-video-generation'],
    ['Генерация изображений', '/project?anchor=project-image-generation'],
    ['Имя MP4 аниматика', '/project?anchor=project-animatic-name']
  ])('ведёт из блока «%s» к ожидаемому якорю %s', (name, href) => {
    expect(links(render(`Перейдите в блок «${name}».`, '/elsewhere'))).toEqual([{ href, text: `«${name}»` }]);
  });

  it('на той же странице сохраняет её параметры и добавляет якорь', () => {
    const html = render('Подготовьте WAV в блоке «Речь».', '/project/production?shot=M01');
    expect(links(html)[0].href).toBe('/project/production?shot=M01&anchor=production-speech');
  });

  it('оставляет текстом кавычки без цели и ссылку на текущую страницу без якоря', () => {
    expect(links(render('Нажмите «Сохранить», затем «Ещё».'))).toEqual([]);
    expect(links(render('Создайте сценарий на странице «Сценарий».', '/project/scenario'))).toEqual([]);
    expect(render('Обычный текст без отсылок.')).toBe('Обычный текст без отсылок.');
  });

  it('ведёт к строке провайдера на странице «Среда», если он назван в том же предложении', () => {
    expect(links(render('Войдите в Тестовый сервис на странице «Среда».'))).toEqual([{ href: '/environment?anchor=test', text: '«Среда»' }]);
    // Провайдер из соседнего предложения не определяет строку.
    expect(links(render('Тестовый сервис доступен. Укажите папку на странице «Среда».'))[0].href).toBe('/environment');
    // Сокращение «См.» не разрывает предложение.
    expect(links(render('Python не найден: проверки недоступны. См. страницу «Среда».'))[0].href).toBe('/environment?anchor=python');
  });

  it.each([
    ['Python', '/environment?anchor=python'],
    ['FFmpeg', '/environment?anchor=ffmpeg'],
    ['ffprobe', '/environment?anchor=ffprobe']
  ])('находит строку зависимости %s на странице среды', (title, href) => {
    expect(links(render(`Проверьте ${title} на странице «Среда».`))).toEqual([{ href, text: '«Среда»' }]);
  });

  it('учитывает порядок упоминаний, отдельные слова и границу строки в ссылке на среду', () => {
    expect(links(render('Проверьте FFmpeg и Python на странице «Среда».'))[0].href).toBe('/environment?anchor=ffmpeg');
    expect(links(render('Проверьте Pythonista на странице «Среда».'))[0].href).toBe('/environment');
    expect(links(render('Тестовый сервис доступен\nУкажите папку на странице «Среда».'))[0].href).toBe('/environment');
    expect(links(render('Войдите в Тестовый сервис в «Среде».'))).toEqual([{ href: '/environment?anchor=test', text: '«Среде»' }]);
  });

  it('без маршрутизатора сохраняет исходный текст и переданное оформление', () => {
    const text = 'Откройте «Исходники» и блок «Речь», затем нажмите «Сохранить».';
    expect(renderToStaticMarkup(createElement(LinkedText, { text }))).toBe(text);
    expect(renderToStaticMarkup(createElement(LinkedText, { text, renderText: (value) => value.toUpperCase() }))).toBe(text.toUpperCase());
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

  it('сохраняет кавычки, пробелы и неизвестные названия среди ссылок', () => {
    const text = '  «Тайминги»\n«Сохранить» — «Речь (липсинк)»; «Сценарий».  ';
    expect(linkSegments(text, '/project/scenario')).toEqual([
      { text: '  ' },
      { text: '«Тайминги»', target: { path: '/project/timing' } },
      { text: '\n«Сохранить» — ' },
      { text: '«Речь (липсинк)»', target: { path: '/project/production', anchor: 'production-speech' } },
      { text: '; «Сценарий».  ' }
    ]);
  });

  it('заменяет прежний якорь и не переносит параметры другой страницы', () => {
    expect(linkLocation({ path: '/project/production', anchor: 'a' }, { pathname: '/project/production', search: '?shot=M01&anchor=b' })).toEqual({
      pathname: '/project/production',
      search: '?shot=M01&anchor=a'
    });
    expect(linkLocation({ path: '/environment' }, { pathname: '/project/scenes', search: '?shot=M01' })).toEqual({ pathname: '/environment', search: '' });
  });
});
