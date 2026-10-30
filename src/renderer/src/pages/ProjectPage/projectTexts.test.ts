/** Независимые ожидания фиксируют целые фразы, числовые границы, экранирование и текстовые переходы обзора проекта. */
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';
import { projectTexts } from '@shared/texts/project';
import { LinkedText } from '../../components/LinkedText';
import { SlottedText } from '../../components/SlottedText';
import { linkSegments } from '../../components/linkTargets';

const renderLinked = (text: string): string =>
  renderToStaticMarkup(createElement(MemoryRouter, { initialEntries: ['/project?keep=yes'] }, createElement(LinkedText, { text })));

const links = (html: string): string[] => [...html.matchAll(/<a [^>]*href="([^"]*)"/g)].map((match) => match[1].replace(/&amp;/g, '&'));

describe('Числа в текстах обзора проекта', () => {
  it.each([
    [0, '0 планов'],
    [1, '1 план'],
    [2, '2 плана'],
    [5, '5 планов'],
    [11, '11 планов'],
    [21, '21 план'],
    [-2, '-2 плана'],
    [1.5, '1.5 плана']
  ])('сохраняет фразы и старое согласование для %s', (count, shots) => {
    expect(projectTexts.checks.shots(count)).toBe(shots);
    expect(projectTexts.checks.acceptedCount({ done: count, total: 21 })).toBe(`${count} из 21`);
    expect(projectTexts.nextStep.scenes({ done: count, total: 21 })).toBe(`Сцены: ${count} из 21`);
    expect(projectTexts.capabilities.models({ provider: 'Новый сервис', count })).toBe(`Новый сервис доступен. Моделей для выбора: ${count}.`);
    expect(projectTexts.bundle.summary({ shots: count, videos: count, copied: count })).toBe(
      `Планов ${count}, из них видео ${count}, скопировано файлов ${count}.`
    );
    expect(projectTexts.bundle.videos({ videos: count, shots: 21 })).toBe(`${count} видео из 21`);
  });
});

describe('Параметры целых фраз проекта', () => {
  const special = 'M<&>"/C:\\клип {date}';

  it('сохраняет имя сервиса, модели и пользовательский путь без интерпретации', () => {
    expect(projectTexts.generation.savedProvider({ provider: special })).toBe(
      'Сохранённый провайдер: M<&>"/C:\\клип {date}. Для запуска выберите его в меню и сохраните настройки.'
    );
    expect(projectTexts.generation.fromFile(special)).toBe('M<&>"/C:\\клип {date} (из файла)');
    expect(projectTexts.generation.modelChoice({ model: special, available: true })).toBe(special);
    expect(projectTexts.generation.modelChoice({ model: special, available: false })).toBe('M<&>"/C:\\клип {date} (недоступна)');
    expect(projectTexts.generation.modelUnavailable({ model: special })).toBe(
      'Модель M<&>"/C:\\клип {date} недоступна у провайдера. Выберите доступную или автоматический подбор модели.'
    );
    expect(projectTexts.generation.agentImageModel({ provider: special })).toBe('Модель агента M<&>"/C:\\клип {date} для изображений');
    expect(projectTexts.generation.agentModelUnavailable({ model: special, defaultModelLabel: 'Из CLI <&>' })).toBe(
      'Модель M<&>"/C:\\клип {date} недоступна у провайдера. Выберите доступную модель или пункт «Из CLI <&>».'
    );
    expect(projectTexts.generation.agentModelHelp({ provider: special })).toBe(
      'По умолчанию используется модель из настроек M<&>"/C:\\клип {date}. Здесь выбирается модель агента, который готовит изображение, а не модель самого генератора изображений.'
    );
    expect(projectTexts.generation.agentExecution({ provider: special })).toBe(
      'Генерацию выполняет M<&>"/C:\\клип {date} встроенным инструментом изображений. Доступные размеры и форматы определяет исполнитель при подготовке запроса. Сейчас создаётся один вариант для каждой опоры. Параметры запроса — количество вариантов, разрешение и пропорции — к этому исполнителю не применяются.'
    );
    expect(projectTexts.generation.resolutionUnavailable(special)).toBe('M<&>"/C:\\клип {date} (недоступно для модели)');
    expect(projectTexts.generation.aspectUnavailable(special)).toBe('M<&>"/C:\\клип {date} (недоступны для модели)');
    expect(projectTexts.bundle.removeDescription({ folder: special })).toBe(
      'Будет удалена папка «M<&>"/C:\\клип {date}» со всем содержимым, включая скопированные медиа. Исходные файлы проекта сохранятся.'
    );
    expect(projectTexts.capabilities.failed({ error: special })).toBe('Не удалось проверить возможности: M<&>"/C:\\клип {date}');
    expect(projectTexts.capabilities.unavailable({ provider: special })).toBe('M<&>"/C:\\клип {date} сейчас недоступен.');
    expect(projectTexts.capabilities.available({ provider: special })).toBe('M<&>"/C:\\клип {date} доступен.');
    expect(projectTexts.capabilities.incomplete({ provider: special })).toBe(
      'M<&>"/C:\\клип {date} доступен, но часть сведений получить не удалось. Нажмите «Повторить проверку».'
    );
  });

  it.each([
    [false, 'доступными моделями'],
    [true, 'предпочтительной моделью']
  ])('сохраняет полные объяснения совместимости при preferredModel=%s', (preferredModel, model) => {
    expect(projectTexts.generation.resolutionUnsupported({ resolution: '4k<&>', preferredModel })).toBe(
      `Разрешение 4k<&> не поддерживается ${model}. Выберите доступное или автоматический подбор модели.`
    );
    expect(projectTexts.generation.aspectUnsupported({ aspect: '21:9<&>', preferredModel })).toBe(
      `Пропорции 21:9<&> не поддерживаются ${model}. Выберите доступное или автоматический подбор модели.`
    );
  });

  it('сохраняет прежнее строковое undefined шаблонов', () => {
    expect(projectTexts.bundle.removeDescription({ folder: undefined })).toBe(
      'Будет удалена папка «undefined» со всем содержимым, включая скопированные медиа. Исходные файлы проекта сохранятся.'
    );
    expect(projectTexts.generation.modelUnavailable({ model: undefined })).toBe(
      'Модель undefined недоступна у провайдера. Выберите доступную или автоматический подбор модели.'
    );
  });

  it('экранирует параметры и оставляет фигурные скобки параметра обычным текстом', () => {
    const html = renderLinked(projectTexts.generation.savedProvider({ provider: special }));
    expect(html).toContain('Сохранённый провайдер: M&lt;&amp;&gt;&quot;/C:\\клип {date}. Для запуска выберите его в меню и сохраните настройки.');
    expect(html).not.toContain('<&>');
  });
});

describe('Переходы и смешанный текст обзора проекта', () => {
  it.each([
    [false, true, true, 'Исправьте ошибки перед сохранением: .', []],
    [true, true, true, 'Исправьте ошибки перед сохранением: поле «Имя MP4 аниматика».', ['project-animatic-name']],
    [false, false, true, 'Исправьте ошибки перед сохранением: блок «Генерация видео».', ['project-video-generation']],
    [false, true, false, 'Исправьте ошибки перед сохранением: блок «Генерация изображений».', ['project-image-generation']],
    [
      true,
      false,
      true,
      'Исправьте ошибки перед сохранением: поле «Имя MP4 аниматика», блок «Генерация видео».',
      ['project-animatic-name', 'project-video-generation']
    ],
    [
      true,
      true,
      false,
      'Исправьте ошибки перед сохранением: поле «Имя MP4 аниматика», блок «Генерация изображений».',
      ['project-animatic-name', 'project-image-generation']
    ],
    [
      false,
      false,
      false,
      'Исправьте ошибки перед сохранением: блок «Генерация видео», блок «Генерация изображений».',
      ['project-video-generation', 'project-image-generation']
    ],
    [
      true,
      false,
      false,
      'Исправьте ошибки перед сохранением: поле «Имя MP4 аниматика», блок «Генерация видео», блок «Генерация изображений».',
      ['project-animatic-name', 'project-video-generation', 'project-image-generation']
    ]
  ])('сохраняет список и порядок ошибок %s/%s/%s', (animaticError, videoValid, imageValid, expected, anchors) => {
    const text = projectTexts.settings.fixBeforeSave({ animaticError, videoValid, imageValid });
    expect(text).toBe(expected);
    expect(
      linkSegments(text)
        .map((segment) => segment.text)
        .join('')
    ).toBe(expected);
    expect(links(renderLinked(text))).toEqual(anchors.map((anchor) => `/project?keep=yes&anchor=${anchor}`));
  });

  it('сохраняет ссылку на среду в причине недоступности сборки', () => {
    expect(projectTexts.bundle.pythonRequired).toBe('Нужен Python: проверьте его на странице «Среда».');
    expect(links(renderLinked(projectTexts.bundle.pythonRequired))).toEqual(['/environment?anchor=python']);
  });

  it('сохраняет один пробел перед датой и безопасный элемент слота', () => {
    const html = renderToStaticMarkup(
      createElement(SlottedText, { text: projectTexts.capabilities.checkedAt, slots: { date: createElement('time', null, '<&>') } })
    );
    expect(html).toBe('Проверено: <time>&lt;&amp;&gt;</time>');
  });
});
