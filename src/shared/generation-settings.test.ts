/** Смена провайдера сбрасывает всё, что от него зависит, — в том числе поля, о которых общий код не знает. */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { registerMediaProviderForTests } from './media-providers';
import { switchGenerationProvider } from './generation-settings';
import { TEST_PROVIDER, testProviderInfo } from './testing/media-provider';

let restore: () => void;
beforeAll(() => {
  restore = registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo);
});
afterAll(() => restore());

it('видео: требования проекта сохраняются, модель, options и неизвестные поля прежнего провайдера сбрасываются', () => {
  const video = {
    provider: 'old',
    provider_selected: true,
    resolution: '4k',
    aspect_ratio: '21:9',
    duration_rule: 'exact_window' as const,
    watermark: false,
    model: 'old-model',
    options: { a: 1 },
    future_provider_flag: true
  };
  expect(switchGenerationProvider('video', video, TEST_PROVIDER)).toEqual({
    ...testProviderInfo.defaults.video,
    provider: TEST_PROVIDER,
    provider_selected: true,
    resolution: '4k',
    aspect_ratio: '21:9',
    duration_rule: 'exact_window',
    watermark: false
  });
});

it('изображения: остаются только поля проекта, параметры запроса берутся из значений по умолчанию нового провайдера', () => {
  const image = { provider: 'old', provider_selected: true, model: 'm', resolution: '4k', aspect_ratio: '1:1', outputs: 3, watermark: false, extra: 'x' };
  expect(switchGenerationProvider('image', image, TEST_PROVIDER)).toEqual({
    ...testProviderInfo.defaults.image,
    provider: TEST_PROVIDER,
    provider_selected: true,
    watermark: false
  });
  // Провайдер без параметров запроса (агент-исполнитель) не получает чужих значений по умолчанию.
  expect(switchGenerationProvider('image', image, 'codex')).toEqual({ provider: 'codex', provider_selected: true, watermark: false });
});
