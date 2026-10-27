/** Проверки формы без Electron: неизвестные предпочтения остаются видимыми, Codex не обещает параметры Kling. */

import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { DEFAULT_IMAGE_GENERATION, DEFAULT_KLING_IMAGE_GENERATION, DEFAULT_VIDEO_GENERATION } from '@shared/types';
import { VideoGenerationSettings } from './VideoGenerationSettings';
import { ImageGenerationSettings } from './ImageGenerationSettings';

const unchanged = (): void => {};

describe('Настройки независимых медиапровайдеров', () => {
  it('показывает сохранённые неизвестные значения видео без замены на известные', () => {
    const html = renderToStaticMarkup(
      createElement(VideoGenerationSettings, {
        project: '/fixture/project',
        value: { ...DEFAULT_VIDEO_GENERATION, provider: 'future-video', resolution: '4K', aspect_ratio: '2:1' },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    expect(html).toContain('future-video');
    expect(html).toContain('4K');
    expect(html).toContain('2:1');
    expect(html).not.toContain('поддерживается только в Kling 4.0');
  });

  it('показывает неизвестного исполнителя изображений как сохранённый выбор', () => {
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: 'future-image', resolution: 'custom-size' },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    expect(html).toContain('future-image');
    expect(html).toContain('custom-size');
  });

  it('показывает значения изображений по умолчанию без сохранения отсутствующих полей', () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, { project: '/fixture/project', value: { provider: 'kling' }, onChange, onAdd: unchanged })
    );
    expect(html).toContain(`value="${DEFAULT_KLING_IMAGE_GENERATION.resolution}"`);
    expect(html).toContain('type="number"');
    expect(html).toContain(`value="${DEFAULT_KLING_IMAGE_GENERATION.outputs}"`);
    expect(html).toContain('Выберите пропорции');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('сохраняет явно заданные количество и разрешение изображений', () => {
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: 'kling', outputs: 3, resolution: '4k' },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    expect(html).toContain('value="4k"');
    expect(html).toContain('value="3"');
  });

  it('показывает автоматический подбор модели обоих видов генерации по умолчанию', () => {
    const video = renderToStaticMarkup(
      createElement(VideoGenerationSettings, { project: '/fixture/project', value: DEFAULT_VIDEO_GENERATION, onChange: unchanged, onAdd: unchanged })
    );
    const image = renderToStaticMarkup(
      createElement(ImageGenerationSettings, { project: '/fixture/project', value: { provider: 'kling' }, onChange: unchanged, onAdd: unchanged })
    );
    expect(video).toContain('Предпочтительная модель видео');
    expect(image).toContain('Предпочтительная модель изображений');
    for (const html of [video, image]) {
      expect(html).toContain('>Автоматически по задаче</div>');
      expect(html).toContain('Автоматически — подбор по требованиям задачи');
      expect(html).toContain('несовместимая будет заменена с объяснением при согласовании');
      expect(html).not.toContain('ввести ID вручную');
      expect(html).not.toContain('Логотип сервиса допустим');
      expect(html).not.toContain('Снять предпочтение логотипа');
    }
  });

  it('показывает сохранённую неизвестную модель недоступной без сброса предпочтения', () => {
    const onChange = vi.fn();
    const video = renderToStaticMarkup(
      createElement(VideoGenerationSettings, {
        project: '/fixture/project',
        value: { ...DEFAULT_VIDEO_GENERATION, model: 'future-video-model' },
        onChange,
        onAdd: unchanged
      })
    );
    const image = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: 'kling', model: 'future-image-model' },
        onChange,
        onAdd: unchanged
      })
    );
    expect(video).toContain('>future-video-model (недоступна)</div>');
    expect(image).toContain('>future-image-model (недоступна)</div>');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('сохраняет явные пропорции и помечает их недоступными, пока CLI не подтвердил поддержку', () => {
    const onChange = vi.fn();
    const video = renderToStaticMarkup(
      createElement(VideoGenerationSettings, {
        project: '/fixture/project',
        value: { ...DEFAULT_VIDEO_GENERATION, model: 'unknown', aspect_ratio: '2:1' },
        onChange,
        onAdd: unchanged
      })
    );
    const image = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: 'kling', model: 'unknown', aspect_ratio: '3:2' },
        onChange,
        onAdd: unchanged
      })
    );
    expect(video).toContain('2:1');
    expect(image).toContain('3:2');
    for (const html of [video, image]) {
      expect(html).toContain('(недоступны для модели)');
      expect(html).not.toContain('aria-invalid="true"');
    }
    expect(onChange).not.toHaveBeenCalled();
  });

  it('для Codex объясняет выбор параметров исполнителем и не показывает поля Kling', () => {
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, { project: '/fixture/project', value: DEFAULT_IMAGE_GENERATION, onChange: unchanged, onAdd: unchanged })
    );
    expect(html).toContain('Codex встроенным инструментом изображений');
    expect(html).toContain('Модель агента Codex для изображений');
    expect(html).toContain('>Как указано в Codex CLI</div>');
    expect(html).toContain('По умолчанию используется модель из настроек Codex CLI.');
    expect(html).toContain('а не модель самого генератора изображений.');
    expect(html).toContain('Доступные размеры и форматы определяет исполнитель');
    expect(html).toContain('Сейчас создаётся один вариант для каждой опоры.');
    expect(html).toContain('Количество вариантов, разрешение и пропорции из параметров Kling к этому исполнителю не применяются.');
    expect(html).toContain(
      'В наших проверках горизонтальные изображения получались размером 1672×941, в том числе при запросе 4K. Точный размер через промпт не гарантируется.'
    );
    expect(html).not.toContain('Предпочтительная модель изображений');
    expect(html).not.toContain('Разрешение изображений');
    expect(html).not.toContain('Количество изображений');
  });

  it('подсвечивает обязательные пустые поля видео и неизвестное правило длительности', () => {
    const html = renderToStaticMarkup(
      createElement(VideoGenerationSettings, {
        project: '/fixture/project',
        value: {
          ...DEFAULT_VIDEO_GENERATION,
          provider: '',
          resolution: '',
          aspect_ratio: '',
          duration_rule: 'unknown' as typeof DEFAULT_VIDEO_GENERATION.duration_rule
        },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    expect(html).toContain('Выберите провайдера видео.');
    expect(html).toContain('Выберите разрешение видео.');
    expect(html).toContain('Выберите пропорции видео.');
    expect(html).toContain('Выберите известное правило длительности.');
    expect(html).toContain('aria-invalid="true"');
  });

  it.each([0, 1.5, Number.NaN])('отклоняет некорректное количество изображений %s', (outputs) => {
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: 'kling', outputs },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    expect(html).toContain('Введите целое количество изображений от 1.');
    expect(html).toContain('aria-invalid="true"');
  });

  it('не считает скрытые параметры Kling ошибками при исполнителе Codex', () => {
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: 'codex', outputs: 0, aspect_ratio: '', resolution: '' },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('Введите целое количество изображений от 1.');
  });

  it('показывает сохранённую модель агента Codex и не стирает её до получения каталога', () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: 'codex', model: 'codex-agent-id', outputs: 0 },
        onChange,
        onAdd: unchanged
      })
    );
    expect(html).toContain('Модель агента Codex для изображений');
    expect(html).toContain('>codex-agent-id (недоступна)</div>');
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('Количество изображений');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('предлагает явно добавить каждый отсутствующий блок отдельно', () => {
    const video = renderToStaticMarkup(
      createElement(VideoGenerationSettings, { project: '/fixture/project', value: null, onChange: unchanged, onAdd: unchanged })
    );
    const image = renderToStaticMarkup(
      createElement(ImageGenerationSettings, { project: '/fixture/project', value: null, onChange: unchanged, onAdd: unchanged })
    );
    expect(video).toContain('Предпочтения видео не заданы');
    expect(image).toContain('Исполнитель изображений не задан');
    expect(video).toContain('Добавить');
    expect(image).toContain('Добавить');
  });
});
