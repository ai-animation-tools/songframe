/** Проверки формы без Electron: неизвестные предпочтения остаются видимыми, провайдер-агент не обещает параметры платного провайдера. */

import { Children, createElement, isValidElement, type ChangeEvent } from 'react';
import type * as Material from '@mui/material';
import { renderToStaticMarkup } from 'react-dom/server';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_GENERATION, DEFAULT_IMAGE_GENERATION, DEFAULT_VIDEO_GENERATION as DEFAULT_VIDEO } from '@shared/types';
import { VideoGenerationSettings } from './VideoGenerationSettings';
import { ImageGenerationSettings } from './ImageGenerationSettings';
import { normalizeProjectSettingsForSave } from './ProjectSettingsCard';
import { MEDIA_PROVIDERS, mediaProvidersFor, registerMediaProviderForTests, type MediaKind } from '@shared/media-providers';
import { TEST_AGENT_PROVIDER, TEST_PROVIDER, testAgentProviderInfo, testProviderInfo } from '@shared/testing/media-provider';

// Провайдер-агент изображений с заметкой настроек: проверяется показ заметок только выбранного провайдера.
const AGENT = TEST_AGENT_PROVIDER;
const AGENT_INFO = { ...testAgentProviderInfo, settingsNotes: { image: 'Заметка тестового агента изображений.' } };
let restoreProviders: (() => void)[] = [];
beforeAll(() => {
  restoreProviders = [registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo), registerMediaProviderForTests(AGENT, AGENT_INFO)];
});
afterAll(() => restoreProviders.forEach((restore) => restore()));
// Видео с платным тестовым провайдером; значения по умолчанию сами провайдера не выбирают.
const DEFAULT_VIDEO_GENERATION = { ...DEFAULT_VIDEO, provider: TEST_PROVIDER };
const TEST_IMAGE_DEFAULTS = testProviderInfo.defaults.image!;
/** Варианты меню провайдеров берутся из реестра в его порядке. */
const providerMenu = (kind: MediaKind) => [
  { value: '', label: 'Не выбрано', disabled: false },
  ...mediaProvidersFor(kind).map((id) => ({ value: id, label: MEDIA_PROVIDERS[id].title, disabled: false }))
];

const { fields, discoveries, appState } = vi.hoisted(() => ({
  fields: new Map<string, Material.TextFieldProps>(),
  discoveries: vi.fn(),
  appState: { agentProvider: 'codex' as 'codex' | 'claude' | null }
}));

vi.mock('../../../state', () => ({ useApp: () => appState }));

beforeEach(() => {
  appState.agentProvider = 'codex';
});

// SSR позволяет вызвать настоящий обработчик поля и проверить, что чтение формы не запускает discovery.
vi.mock('@mui/material', async (importOriginal) => {
  const original = await importOriginal<typeof Material>();
  return {
    ...original,
    TextField: (props: Material.TextFieldProps) => {
      if (props.id) fields.set(props.id, props);
      return createElement(original.TextField, props);
    }
  };
});
vi.mock('./MediaCapabilitiesPanel', () => ({
  MediaCapabilitiesPanel: (props: unknown) => {
    discoveries(props);
    return null;
  }
}));

const unchanged = (): void => {};
// Закрытое меню не попадает в SSR, поэтому варианты читаются из дочерних элементов поля.
const menuItems = (id: string): { value: unknown; label: unknown; disabled: boolean }[] =>
  Children.toArray(fields.get(id)?.children)
    .filter(isValidElement)
    .map((item) => {
      const props = item.props as { value?: unknown; children?: unknown; disabled?: boolean };
      return { value: props.value, label: props.children, disabled: Boolean(props.disabled) };
    });

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
    expect(html).not.toContain('поддерживается только в');
  });

  it('показывает неизвестного исполнителя изображений как сохранённый выбор', () => {
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: 'future-image', provider_selected: true, resolution: 'custom-size' },
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
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: TEST_PROVIDER, provider_selected: true },
        onChange,
        onAdd: unchanged
      })
    );
    expect(html).toContain(`value="${TEST_IMAGE_DEFAULTS.resolution}"`);
    expect(html).toContain('type="number"');
    expect(html).toContain(`value="${TEST_IMAGE_DEFAULTS.outputs}"`);
    expect(html).toContain('Выберите пропорции');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('сохраняет явно заданные количество и разрешение изображений', () => {
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: TEST_PROVIDER, provider_selected: true, outputs: 3, resolution: '4k' },
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
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: TEST_PROVIDER, provider_selected: true },
        onChange: unchanged,
        onAdd: unchanged
      })
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
        value: { provider: TEST_PROVIDER, provider_selected: true, model: 'future-image-model' },
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
        value: { provider: TEST_PROVIDER, provider_selected: true, model: 'unknown', aspect_ratio: '3:2' },
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

  it('блоки провайдера-агента показываются только при выбранном провайдере-агенте', () => {
    const render = (provider: string): string =>
      renderToStaticMarkup(
        createElement(ImageGenerationSettings, {
          project: '/fixture/project',
          value: { provider, provider_selected: true },
          onChange: unchanged,
          onAdd: unchanged
        })
      );
    const agent = render(AGENT);
    expect(agent).toContain(AGENT_INFO.settingsNotes.image);
    expect(agent).toContain(`Модель агента ${AGENT_INFO.title} для изображений`);
    const other = render(TEST_PROVIDER);
    expect(other).not.toContain(AGENT_INFO.settingsNotes.image);
    expect(other).not.toContain('Модель агента');
    expect(other).not.toContain('Генерацию выполняет');
  });

  it('при «Не выбрано» не показывает поля и заметки сохранённого, но не подтверждённого провайдера', () => {
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: AGENT, model: 'saved-agent-model' },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    expect(html).toContain(`Сохранённый провайдер: ${AGENT_INFO.title}.`);
    expect(html).not.toContain(AGENT_INFO.settingsNotes.image);
    expect(html).not.toContain('Генерацию выполняет');
    expect(html).not.toContain('Модель агента');
    expect(html).not.toContain('Разрешение изображений');
  });

  it('для провайдера-агента объясняет выбор параметров исполнителем и не показывает поля платного провайдера', () => {
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { ...DEFAULT_IMAGE_GENERATION, provider: AGENT, provider_selected: true },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    expect(html).toContain(`Генерацию выполняет ${AGENT_INFO.title} встроенным инструментом изображений`);
    expect(html).toContain(`Модель агента ${AGENT_INFO.title} для изображений`);
    expect(html).toContain(`>${AGENT_INFO.defaultModelLabel}</div>`);
    expect(html).toContain(`По умолчанию используется модель из настроек ${AGENT_INFO.title}.`);
    expect(html).toContain('а не модель самого генератора изображений.');
    expect(html).toContain('Доступные размеры и форматы определяет исполнитель');
    expect(html).toContain('Сейчас создаётся один вариант для каждой опоры.');
    expect(html).toContain('Параметры запроса — количество вариантов, разрешение и пропорции — к этому исполнителю не применяются.');
    expect(html).toContain(AGENT_INFO.settingsNotes.image);
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
          provider_selected: true,
          resolution: '',
          aspect_ratio: '',
          duration_rule: 'unknown' as typeof DEFAULT_VIDEO_GENERATION.duration_rule
        },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    expect(html).toContain('Выберите провайдера видео и сохраните настройки.');
    expect(html).toContain('Выберите разрешение видео.');
    expect(html).toContain('Выберите пропорции видео.');
    expect(html).toContain('Выберите известное правило длительности.');
    expect(html).toContain('aria-invalid="true"');
  });

  it.each([0, 1.5, Number.NaN])('отклоняет некорректное количество изображений %s', (outputs) => {
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: TEST_PROVIDER, provider_selected: true, outputs },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    expect(html).toContain('Введите целое количество изображений от 1.');
    expect(html).toContain('aria-invalid="true"');
  });

  it('не считает скрытые параметры платного провайдера ошибками при исполнителе-агенте', () => {
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: AGENT, provider_selected: true, outputs: 0, aspect_ratio: '', resolution: '' },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('Введите целое количество изображений от 1.');
  });

  it('показывает сохранённую модель провайдера-агента и не стирает её до получения каталога', () => {
    const onChange = vi.fn();
    const html = renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: AGENT, provider_selected: true, model: 'saved-agent-id', outputs: 0 },
        onChange,
        onAdd: unchanged
      })
    );
    expect(html).toContain(`Модель агента ${AGENT_INFO.title} для изображений`);
    expect(html).toContain('>saved-agent-id (недоступна)</div>');
    expect(html).not.toContain('aria-invalid="true"');
    expect(html).not.toContain('Количество изображений');
    expect(onChange).not.toHaveBeenCalled();
  });

  it('не выбирает провайдеров через общий default', () => {
    expect(DEFAULT_GENERATION).toEqual({ video: null, image: null });
  });

  it.each([undefined, false])('показывает старого провайдера без маркера %s как «Не выбрано» и не читает CLI', (provider_selected) => {
    const onChange = vi.fn();
    discoveries.mockClear();
    for (const kind of ['image', 'video'] as const) {
      const value = kind === 'image' ? { provider: AGENT, provider_selected, model: 'saved-model' } : { ...DEFAULT_VIDEO_GENERATION, provider_selected };
      const html = renderToStaticMarkup(
        kind === 'image'
          ? createElement(ImageGenerationSettings, { project: '/fixture/project', value, onChange, onAdd: unchanged })
          : createElement(VideoGenerationSettings, {
              project: '/fixture/project',
              value: { ...DEFAULT_VIDEO_GENERATION, provider_selected },
              onChange,
              onAdd: unchanged
            })
      );
      expect(fields.get(`${kind}-generation-provider`)?.value).toBe('');
      expect(html).toContain('Не выбрано');
      expect(html).toContain('Сохранённый провайдер:');
    }
    expect(discoveries).not.toHaveBeenCalled();
    expect(onChange).not.toHaveBeenCalled();
  });

  it('подтверждает повторный выбор того же старого провайдера только через dropdown и сохраняет расширения', () => {
    const onChange = vi.fn();
    const image = { provider: AGENT, model: 'saved-model', resolution: 'custom', options: { keep: true } };
    renderToStaticMarkup(createElement(ImageGenerationSettings, { project: '/fixture/project', value: image, onChange, onAdd: unchanged }));
    expect(onChange).not.toHaveBeenCalled();
    const chooseImage = fields.get('image-generation-provider')?.onChange;
    chooseImage?.({ target: { value: AGENT } } as ChangeEvent<HTMLInputElement>);
    expect(onChange).toHaveBeenLastCalledWith({ ...image, provider_selected: true });
    // До подтверждения провайдера поля модели нет: правка соседнего поля не может подменить выбор.
    fields.clear();
    renderToStaticMarkup(createElement(ImageGenerationSettings, { project: '/fixture/project', value: image, onChange, onAdd: unchanged }));
    expect(fields.has('image-generation-model')).toBe(false);
    renderToStaticMarkup(createElement(VideoGenerationSettings, { project: '/fixture/project', value: DEFAULT_VIDEO_GENERATION, onChange, onAdd: unchanged }));
    fields.get('video-generation-provider')?.onChange?.({ target: { value: TEST_PROVIDER } } as ChangeEvent<HTMLInputElement>);
    expect(onChange).toHaveBeenLastCalledWith({ ...DEFAULT_VIDEO_GENERATION, provider_selected: true });
  });

  it('читает возможности только после явного выбора провайдера', () => {
    discoveries.mockClear();
    renderToStaticMarkup(
      createElement(ImageGenerationSettings, {
        project: '/fixture/project',
        value: { provider: AGENT, provider_selected: true },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    renderToStaticMarkup(
      createElement(VideoGenerationSettings, {
        project: '/fixture/project',
        value: { ...DEFAULT_VIDEO_GENERATION, provider_selected: true },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    expect(discoveries).toHaveBeenCalledTimes(2);
  });

  it.each([null, 'claude', 'codex'] as const)(
    'предлагает провайдера-агента и платного провайдера для изображений и читает их возможности при агенте %s',
    (agent) => {
      appState.agentProvider = agent;
      discoveries.mockClear();
      for (const provider of [AGENT, TEST_PROVIDER]) {
        const onChange = vi.fn();
        const html = renderToStaticMarkup(
          createElement(ImageGenerationSettings, { project: '/fixture/project', value: { provider, provider_selected: true }, onChange, onAdd: unchanged })
        );
        expect(html).not.toContain('выберите агента');
        expect(menuItems('image-generation-provider')).toEqual(providerMenu('image'));
        expect(menuItems('image-generation-provider')).toContainEqual({ value: AGENT, label: AGENT_INFO.title, disabled: false });
        expect(menuItems('image-generation-provider')).toContainEqual({ value: TEST_PROVIDER, label: MEDIA_PROVIDERS[TEST_PROVIDER].title, disabled: false });
        expect(onChange).not.toHaveBeenCalled();
      }
      renderToStaticMarkup(
        createElement(VideoGenerationSettings, {
          project: '/fixture/project',
          value: { ...DEFAULT_VIDEO_GENERATION, provider_selected: true },
          onChange: unchanged,
          onAdd: unchanged
        })
      );
      expect(discoveries).toHaveBeenCalledTimes(3);
      expect(discoveries.mock.calls.map(([props]) => (props as { provider: string }).provider)).toEqual([AGENT, TEST_PROVIDER, TEST_PROVIDER]);
    }
  );

  it('разрешает выбрать провайдера-агента для изображений при агенте Claude и подставляет параметры только провайдеру с параметрами запроса', () => {
    appState.agentProvider = 'claude';
    const onChange = vi.fn();
    const value = { provider: TEST_PROVIDER, provider_selected: false, model: 'saved-model', watermark: false };
    renderToStaticMarkup(createElement(ImageGenerationSettings, { project: '/fixture/project', value, onChange, onAdd: unchanged }));
    const choose = fields.get('image-generation-provider')?.onChange;
    // Другой провайдер: модель прежнего не переносится, у провайдера-агента нет параметров запроса.
    choose?.({ target: { value: AGENT } } as ChangeEvent<HTMLInputElement>);
    expect(onChange).toHaveBeenLastCalledWith({ provider: AGENT, provider_selected: true, watermark: false });
    // Повторное подтверждение того же сохранённого провайдера сохраняет его значения и дополняет недостающие.
    choose?.({ target: { value: TEST_PROVIDER } } as ChangeEvent<HTMLInputElement>);
    expect(onChange).toHaveBeenLastCalledWith({
      ...value,
      provider_selected: true,
      resolution: TEST_IMAGE_DEFAULTS.resolution,
      aspect_ratio: TEST_IMAGE_DEFAULTS.aspect_ratio,
      outputs: TEST_IMAGE_DEFAULTS.outputs
    });
  });

  it('при смене провайдера сбрасывает поля прежнего и подставляет значения нового', () => {
    const onChange = vi.fn();
    const image = { provider: AGENT, provider_selected: true, model: 'gpt-agent', resolution: '4k', aspect_ratio: '21:9', outputs: 3, options: { x: 1 } };
    renderToStaticMarkup(createElement(ImageGenerationSettings, { project: '/fixture/project', value: image, onChange, onAdd: unchanged }));
    fields.get('image-generation-provider')?.onChange?.({ target: { value: TEST_PROVIDER } } as ChangeEvent<HTMLInputElement>);
    expect(onChange).toHaveBeenLastCalledWith({ provider: TEST_PROVIDER, provider_selected: true, ...TEST_IMAGE_DEFAULTS });
    const video = { ...DEFAULT_VIDEO_GENERATION, provider: 'future-video', provider_selected: true, model: 'old-model', options: { y: 2 } };
    renderToStaticMarkup(createElement(VideoGenerationSettings, { project: '/fixture/project', value: video, onChange, onAdd: unchanged }));
    fields.get('video-generation-provider')?.onChange?.({ target: { value: TEST_PROVIDER } } as ChangeEvent<HTMLInputElement>);
    const { model: _model, options: _options, ...kept } = video;
    // Разрешение, пропорции и правило длительности — требования проекта: они остаются.
    expect(onChange).toHaveBeenLastCalledWith({ ...kept, provider: TEST_PROVIDER, provider_selected: true });
  });

  it('предлагает для видео только провайдеров видео из реестра', () => {
    renderToStaticMarkup(
      createElement(VideoGenerationSettings, {
        project: '/fixture/project',
        value: { ...DEFAULT_VIDEO_GENERATION, provider_selected: true },
        onChange: unchanged,
        onAdd: unchanged
      })
    );
    expect(menuItems('video-generation-provider')).toEqual(providerMenu('video'));
    expect(menuItems('video-generation-provider')).not.toContainEqual(expect.objectContaining({ value: AGENT }));
  });

  it('берёт подписи модели по умолчанию из реестра', () => {
    for (const provider of [AGENT, TEST_PROVIDER]) {
      const html = renderToStaticMarkup(
        createElement(ImageGenerationSettings, {
          project: '/fixture/project',
          value: { provider, provider_selected: true },
          onChange: unchanged,
          onAdd: unchanged
        })
      );
      expect(html).toContain(`>${MEDIA_PROVIDERS[provider].defaultModelLabel}</div>`);
    }
  });

  it('сохраняет пустую неподтверждённую форму как null без выбора агента и не удаляет старые настройки', () => {
    appState.agentProvider = null;
    const image = { provider: AGENT, provider_selected: false, model: 'saved-model', options: { keep: true } };
    const video = { ...DEFAULT_VIDEO_GENERATION, provider: '', provider_selected: false };
    const settings = { name: 'Клип', animaticVideo: 'clip.mp4', generation: { video, image, custom: { keep: true } } };
    expect(normalizeProjectSettingsForSave(settings)).toEqual({ ...settings, generation: { ...settings.generation, video: null } });
    expect(
      normalizeProjectSettingsForSave({ ...settings, generation: { ...settings.generation, video: { ...video, provider_selected: true } } }).generation?.video
    ).toEqual({ ...video, provider_selected: true });
    const emptyImage = { provider: '' };
    expect(normalizeProjectSettingsForSave({ ...settings, generation: { ...settings.generation, image: emptyImage } }).generation?.image).toBeNull();
    expect(settings.generation.video).toBe(video);
    for (const html of [
      renderToStaticMarkup(createElement(ImageGenerationSettings, { project: '/fixture/project', value: emptyImage, onChange: unchanged, onAdd: unchanged })),
      renderToStaticMarkup(createElement(VideoGenerationSettings, { project: '/fixture/project', value: video, onChange: unchanged, onAdd: unchanged }))
    ]) {
      expect(html).toContain('Провайдер не выбран. Сохранение оставит генерацию отключённой.');
      expect(html).not.toContain('aria-invalid="true"');
    }
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
