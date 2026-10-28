/** Проверяем связь референсов с именованными слотами и отделение локальной подготовки от платной отправки. */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from 'vitest';
import type { MediaCapabilities, MediaModel } from '@shared/media-providers';
import type { ProductionImagesInput } from '@shared/production-workflow';
import type { ImageGenerationSettings } from '@shared/types';
import { frameImageRequest as prepareFrameRequest } from './frame-image-request';
import { registerTestMediaProvider, TEST_PROVIDER, testPaidAdapter } from './testing/media-provider';

let restoreProvider: () => void;
beforeAll(() => {
  restoreProvider = registerTestMediaProvider();
});
afterAll(() => restoreProvider());
const frameImageRequest = (request: ProductionImagesInput, settings: ImageGenerationSettings, capabilities: MediaCapabilities) =>
  prepareFrameRequest(testPaidAdapter, request, settings, capabilities);

let project: string;
let input: ProductionImagesInput;
let caps: MediaCapabilities;
beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-frame-request-'));
  mkdirSync(join(project, 'source'));
  const png = Buffer.alloc(28);
  Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
  png.writeUInt32BE(1, 16);
  png.writeUInt32BE(1, 20);
  for (const name of ['first.png', 'second.png']) writeFileSync(join(project, 'source', name), png);
  input = {
    project,
    packageDir: join(project, 'plan/batches/M01-attempt-01'),
    shot: 'M01',
    frames: [{ id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Персонаж на станции.', referencePaths: ['source/first.png', 'source/second.png'] }]
  };
  caps = {
    provider: TEST_PROVIDER,
    kind: 'image',
    available: true,
    checkedAt: '2026-10-26',
    generationVerified: false,
    problems: [],
    models: [
      {
        id: 'selected-image',
        command: 'image_to_image',
        arguments: { img_resolution: {}, aspect_ratio: {}, story_mode: {} },
        slots: { image_10: {}, image_2: {}, image_1: { required: true } },
        limits: {}
      }
    ]
  };
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

it('связывает N-й референс с image_N независимо от порядка ключей capabilities', () => {
  const request = frameImageRequest(input, { provider: TEST_PROVIDER, model: 'selected-image', resolution: '1k', aspect_ratio: '16:9' }, caps);
  expect(request.inputs.map((item) => [item.slot, item.path])).toEqual([
    ['image_1', join(project, 'source/first.png')],
    ['image_2', join(project, 'source/second.png')]
  ]);
  expect(request.parameters).toEqual({ img_resolution: '1k', aspect_ratio: '16:9', story_mode: false });
  expect(request.outputs).toBe(1);
});

it('не подменяет отсутствующий image_2 другим имеющимся слотом', () => {
  delete caps.models[0].slots.image_2;
  expect(() => frameImageRequest(input, { provider: TEST_PROVIDER, model: 'selected-image' }, caps)).toThrow('Вход image_2 не объявлен');
});

it('разделяет T2I и I2I и запрещает скрытую серию вместо одной опоры', () => {
  input.frames[0].referencePaths = [];
  expect(() => frameImageRequest(input, { provider: TEST_PROVIDER, model: 'selected-image' }, caps)).toThrow('не объявлена');
  caps.models[0].command = 'text_to_image';
  caps.models[0].slots = {};
  expect(frameImageRequest(input, { provider: TEST_PROVIDER, model: 'selected-image' }, caps).command).toBe('text_to_image');
  expect(() => frameImageRequest(input, { provider: TEST_PROVIDER, model: 'selected-image', options: { story_mode: true } }, caps)).toThrow('без серии');
});

it('без предпочтения выбирает совместимую модель с 2k и одним изображением', () => {
  const request = frameImageRequest(input, { provider: TEST_PROVIDER }, caps);
  expect(request.model).toBe('selected-image');
  expect(request.preferredModel).toBeNull();
  expect(request.modelSelection).toMatchObject({ preferredModel: null, selectedModel: 'selected-image' });
  expect(request.parameters).toEqual({ img_resolution: '2k', aspect_ratio: '16:9', story_mode: false });
  expect(request.outputs).toBe(1);
});

it('не переносит exact ID между T2I и I2I и объясняет совместимый fallback', () => {
  caps.models.unshift({ ...caps.models[0], id: 'preferred-t2i', command: 'text_to_image' });
  const request = frameImageRequest(input, { provider: TEST_PROVIDER, model: 'preferred-t2i' }, caps);
  expect(request.model).toBe('selected-image');
  expect(request.modelSelection?.reason).toContain('preferred-t2i не объявлена для команды image_to_image');
});

it('отклоняет предпочтительную модель по resolution, aspect_ratio, slots и count без изменения требований', () => {
  caps.models[0].arguments.image_count = { allowed: ['1', '2'] };
  const incompatibleModels: Partial<MediaModel>[] = [
    { arguments: { ...caps.models[0].arguments, img_resolution: { allowed: ['1k'] } } },
    { arguments: { ...caps.models[0].arguments, aspect_ratio: { allowed: ['1:1'] } } },
    { slots: { image_1: {} } },
    { arguments: { ...caps.models[0].arguments, image_count: { allowed: ['1'] } } },
    { slots: { ...caps.models[0].slots, first_image: { required: true } } }
  ];
  for (const incompatible of incompatibleModels) {
    caps.models = [{ ...caps.models[caps.models.length - 1], id: 'preferred', ...incompatible }, caps.models[caps.models.length - 1]];
    const request = frameImageRequest(input, { provider: TEST_PROVIDER, model: 'preferred', aspect_ratio: '16:9', outputs: 2 }, caps);
    expect(request.model).toBe('selected-image');
    expect(request.outputs).toBe(2);
    expect(request.parameters.img_resolution).toBe('2k');
    expect(request.parameters.aspect_ratio).toBe('16:9');
    expect(request.inputs.map((item) => item.slot)).toEqual(['image_1', 'image_2']);
  }
});

it('сохраняет явные provider options и не добавляет не объявленный story_mode', () => {
  delete caps.models[0].arguments.story_mode;
  const request = frameImageRequest(input, { provider: TEST_PROVIDER, options: { img_resolution: '1k' }, watermark: true }, caps);
  expect(request.parameters).toEqual({ img_resolution: '1k', aspect_ratio: '16:9' });
  expect(() => frameImageRequest(input, { provider: TEST_PROVIDER, options: { unsupported_option: 7 } }, caps)).toThrow('unsupported_option=7');
  expect(frameImageRequest(input, { provider: TEST_PROVIDER, watermark: false }, caps).parameters).not.toHaveProperty('watermark');
});

it('игнорирует старое отдельное watermark и запрашивает без логотипа только при объявленном флаге', () => {
  for (const watermark of [false, true]) {
    expect(frameImageRequest(input, { provider: TEST_PROVIDER, watermark }, caps).parameters).not.toHaveProperty('watermark');
  }
  caps.models[0].arguments.watermark = { allowed: ['true', 'false'] };
  for (const watermark of [false, true, undefined]) {
    expect(frameImageRequest(input, { provider: TEST_PROVIDER, watermark }, caps).parameters.watermark).toBe(false);
  }
  for (const watermark of [true, 'true']) {
    expect(() => frameImageRequest(input, { provider: TEST_PROVIDER, options: { watermark } }, caps)).toThrow('Снимите устаревшую настройку watermark=true');
  }
});

it('сохраняет явные aspect aliases из options вместо неявного default', () => {
  caps.models[0].arguments.aspect_ratio = { allowed: ['1:1', '16:9'] };
  for (const name of ['aspect_ratio', 'aspectRatio']) {
    const request = frameImageRequest(input, { provider: TEST_PROVIDER, options: { [name]: '1:1' } }, caps);
    expect(request.parameters.aspect_ratio).toBe('1:1');
    expect(request.parameters).not.toHaveProperty('aspectRatio');
  }
});
