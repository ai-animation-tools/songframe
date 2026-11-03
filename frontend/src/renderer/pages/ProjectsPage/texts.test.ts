/** Независимые ожидания сохраняют параметры, пустые значения и маршруты сообщений выбора проекта. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { projectsTexts } from '@shared/texts/projects';
import { LinkedText } from '../../components/LinkedText';
import { ProjectHistory } from './components/ProjectHistory';
import { NewProjectForm } from '../NewProjectPage/components/NewProjectForm';

const renderLinked = (text: string): string =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/projects'] }, createElement(LinkedText, { text })));

describe('Тексты создания и выбора проекта', () => {
  const name = '<&>"/C:\\клип {name}';

  it('сохраняет целые фразы с именем пользователя и экранирует вывод', () => {
    expect(projectsTexts.created({ name })).toBe('Проект «<&>"/C:\\клип {name}» создан');
    expect(projectsTexts.forget({ name })).toBe('Убрать проект «<&>"/C:\\клип {name}» из истории');
    expect(renderLinked(projectsTexts.created({ name }))).toBe('Проект «&lt;&amp;&gt;&quot;/C:\\клип {name}» создан');
    expect(projectsTexts.created({ name: '' })).toBe('Проект «» создан');
  });

  it.each([null, undefined, ''])('сохраняет отсутствие даты %s без лишнего суффикса', (openedAt) => {
    expect(projectsTexts.historyDetails({ path: name, exists: true, openedAt })).toBe('<&>"/C:\\клип {name}');
    expect(projectsTexts.historyDetails({ path: name, exists: false, openedAt })).toBe('<&>"/C:\\клип {name} (папка не найдена)');
  });

  it('сохраняет порядок пути, отметки отсутствия и даты', () => {
    expect(projectsTexts.historyDetails({ path: 'C:\\новый & клип', exists: false, openedAt: '29.10.2026, 12:34' })).toBe(
      'C:\\новый & клип (папка не найдена) · открыт 29.10.2026, 12:34'
    );
    expect(projectsTexts.historyDetails({ path: '', exists: true, openedAt: '0' })).toBe(' · открыт 0');
  });

  it.each([
    ['Ресурсы приложения не найдены: см. страницу «Среда».', () => projectsTexts.resourcesMissing],
    ['Ресурсы приложения не найдены, шаблон проекта недоступен. Подробности на странице «Среда».', () => projectsTexts.templateUnavailable],
    [
      'Ресурсы приложения не найдены: создание проектов и инструменты недоступны, просмотр работает. Подробности на странице «Среда».',
      () => projectsTexts.toolsUnavailable
    ]
  ])('сохраняет фразу и маршрут среды: %s', (expected, text) => {
    expect(text()).toBe(expected);
    const html = renderLinked(text());
    expect([...html.matchAll(/<a [^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/g)].map((match) => [match[1], match[2]])).toEqual([['/environment', '«Среда»']]);
    expect(html.replace(/<style[^>]*>[\s\S]*?<\/style>/g, '').replace(/<[^>]*>/g, '')).toBe(expected);
  });

  it('показывает прежнее пустое состояние и значения формы без вызова API', () => {
    const history = renderToStaticMarkup(
      createElement(ProjectHistory, { history: [], states: {}, currentPath: null, busy: false, onOpen: () => undefined, onForget: () => undefined })
    );
    expect(history).toContain('История пуста. Откройте папку существующего клипа или создайте новый проект.');
    const form = renderToStaticMarkup(
      createElement(NewProjectForm, {
        values: { name: '', path: '', video: '' },
        changeField: () => undefined,
        pickParent: async () => undefined,
        problems: [],
        touched: false
      })
    );
    expect(form).toContain('Название клипа');
    expect(form).toContain('Полный путь к новой папке');
    expect(form).toContain('placeholder="animatic.mp4"');
    expect(form).toContain('Попадёт в plan/project.json, README и заголовки документов');
  });
});
