/** Подсказки объединяют объявления CLI и сохраняют порядок точных ID, размеров и пропорций. */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { registerMediaProviderForTests, type MediaModel } from '@shared/media-providers';
import { TEST_PROVIDER, testProviderInfo } from '@shared/testing/media-provider';
import { aspectOptions, modelOptions, resolutionOptions, sortAspects, sortResolutions } from './generationOptions';

const model = (id: string, command: string, args: MediaModel['arguments'] = {}): MediaModel => ({ id, command, arguments: args, slots: {}, limits: {} });
let restoreProvider: () => void;
beforeAll(() => {
  restoreProvider = registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo);
});
afterAll(() => restoreProvider());

describe('Подсказки генерации из возможностей CLI', () => {
  it('ранжирует только обнаруженные модели по порядку реестра провайдера и сохраняет одинаковые ID разных команд', () => {
    const models = [
      model('test-image', 'image_to_image'),
      model('test-image-pro', 'text_to_image'),
      model('future-7', 'text_to_image'),
      model('test-image', 'text_to_image'),
      model('future-10', 'text_to_image')
    ];
    expect(modelOptions(models, 'image', TEST_PROVIDER)).toEqual(['test-image-pro', 'test-image', 'future-7', 'future-10']);
    expect(modelOptions([], 'image', TEST_PROVIDER)).toEqual([]);
    expect(
      modelOptions([model('future', 'text_to_video'), model('test-video', 'text_to_video'), model('test-video-pro', 'image_to_video')], 'video', TEST_PROVIDER)
    ).toEqual(['test-video-pro', 'test-video', 'future']);
    // Без известного провайдера порядок только алфавитный.
    expect(modelOptions(models, 'image', 'unknown')).toEqual(['future-7', 'future-10', 'test-image', 'test-image-pro']);
  });

  it('сортирует разрешение по размеру и пропорции от широких к вертикальным', () => {
    expect(sortResolutions(['720p', '1k', '4k', '1080p', '0.5k', '2k', '4k'])).toEqual(['4k', '2k', '1080p', '720p', '1k', '0.5k']);
    expect(sortAspects(['auto', '9:16', '1:1', '16:9', '21:9', '1:1'])).toEqual(['21:9', '16:9', '1:1', '9:16', 'auto']);
    expect(sortAspects(['2:3', 'auto', '4:5', '3:2', '9:16', '1:1', '5:4', '4:3', '3:4', '16:9', '21:9'])).toEqual([
      '21:9',
      '16:9',
      '3:2',
      '4:3',
      '5:4',
      '1:1',
      '4:5',
      '3:4',
      '2:3',
      '9:16',
      'auto'
    ]);
  });

  it('объединяет требования доступных моделей, сохраняя общий порядок без дубликатов', () => {
    const models = [
      model('new', 'text_to_image', { img_resolution: { allowed: ['1k', '4k', '2k'] }, aspect_ratio: { allowed: ['auto', '1:1', '21:9'] } }),
      model('old', 'image_to_image', { resolution: { allowed: ['2k', '1080p'] }, aspect_ratio: { allowed: ['16:9', '1:1'] } })
    ];
    expect(resolutionOptions(models)).toEqual(['4k', '2k', '1080p', '1k']);
    expect(aspectOptions(models)).toEqual(['21:9', '16:9', '1:1', 'auto']);
    expect(resolutionOptions([])).toEqual([]);
    expect(aspectOptions([])).toEqual([]);
  });

  it('ограничивает пропорции выбранным ID, а для автоматического подбора объединяет весь каталог', () => {
    const models = [
      model('wide', 'text_to_image', { aspect_ratio: { allowed: ['auto', '16:9', '21:9'] } }),
      model('wide', 'image_to_image', { aspect_ratio: { allowed: ['1:1', '16:9'] } }),
      model('portrait', 'text_to_image', { aspect_ratio: { allowed: ['3:4', '9:16'] } }),
      model('no-ratios', 'text_to_image')
    ];
    expect(aspectOptions(models, 'wide')).toEqual(['21:9', '16:9', '1:1', 'auto']);
    expect(aspectOptions(models, 'portrait')).toEqual(['3:4', '9:16']);
    expect(aspectOptions(models, 'no-ratios')).toEqual([]);
    expect(aspectOptions(models, 'unknown')).toEqual([]);
    expect(aspectOptions(models, '')).toEqual(['21:9', '16:9', '1:1', '3:4', '9:16', 'auto']);
    expect(aspectOptions(models)).toEqual(aspectOptions(models, ''));
  });

  it('ограничивает разрешения выбранным ID и объединяет варианты его команд', () => {
    const models = [
      model('high', 'text_to_image', { img_resolution: { allowed: ['2k', '4k'] } }),
      model('high', 'image_to_image', { resolution: { allowed: ['1k', '2k'] } }),
      model('low', 'text_to_image', { img_resolution: { allowed: ['720p'] } }),
      model('no-sizes', 'text_to_image')
    ];
    expect(resolutionOptions(models, 'high')).toEqual(['4k', '2k', '1k']);
    expect(resolutionOptions(models, 'low')).toEqual(['720p']);
    expect(resolutionOptions(models, 'no-sizes')).toEqual([]);
    expect(resolutionOptions(models, 'unknown')).toEqual([]);
    expect(resolutionOptions(models, '')).toEqual(['4k', '2k', '720p', '1k']);
    expect(resolutionOptions(models)).toEqual(resolutionOptions(models, ''));
  });
});
