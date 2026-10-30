/** Общий платный адаптер проверяется на провайдере test: подставной discovery и офлайн-подготовка без CLI и сети. */
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaCapabilities, MediaKind } from '@shared/media-providers';
import { PaidMediaProvider, selectPaidRequest, type MediaProviderOptions, type PreparePaidInput } from './media-providers';
import { prepareOffline, registerTestMediaProvider, TEST_PROVIDER, testPaidAdapter } from './testing/media-provider';

const COMMANDS: Record<MediaKind, string[]> = {
  image: ['text_to_image', 'image_to_image'],
  video: ['text_to_video', 'image_to_video', 'omni_ref_video', 'motion_control']
};
let restoreProvider: () => void;
beforeAll(() => {
  restoreProvider = registerTestMediaProvider();
});
afterAll(() => restoreProvider());
const select = (request: PreparePaidInput, capabilities: MediaCapabilities) => selectPaidRequest(testPaidAdapter, request, capabilities);
const imageProvider = (): PaidMediaProvider => new PaidMediaProvider(testPaidAdapter, 'image', options);
const videoProvider = (): PaidMediaProvider => new PaidMediaProvider(testPaidAdapter, 'video', options);
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
let work: string;
let project: string;
let options: MediaProviderOptions;
let input: PreparePaidInput;
let caps: MediaCapabilities;
const hash = (data: Buffer): string => createHash('sha256').update(data).digest('hex');
const model = {
  arguments: { prompt: { required: true }, resolution: { allowed: ['1k'] }, image_count: { allowed: ['1', '2'] } },
  slots: { image_1: { required: true }, image_2: { required: false } },
  limits: { combined_item_cap: { maxItems: 1, arguments: [], inputPrefixes: ['image_'] } }
};

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-media-test-'));
  project = join(work, 'project');
  mkdirSync(join(project, 'source'), { recursive: true });
  writeFileSync(join(project, 'source/reference.png'), png);
  input = {
    project,
    workDir: join(work, 'attempt'),
    shot: 'M01',
    kind: 'image',
    command: 'image_to_image',
    model: 'image-exact',
    prompt: 'Сохрани персонажа.',
    parameters: { resolution: '1k', image_count: 1 },
    outputs: 1,
    inputs: [{ flag: 'input', slot: 'image_1', path: 'source/reference.png', role: 'reference' }],
    frameId: 'K01'
  };
  caps = {
    provider: TEST_PROVIDER,
    kind: 'image',
    checkedAt: new Date().toISOString(),
    available: true,
    generationVerified: false,
    models: [{ ...model, id: input.model, command: input.command }],
    problems: []
  };
  options = {
    launcher: () => ({
      run: vi.fn(async (_project, _tool, args) => {
        if (args[0] === 'capabilities') {
          const kind = args[args.indexOf('--kind') + 1] as MediaKind;
          return {
            code: 0,
            stdout: JSON.stringify({ reports: COMMANDS[kind].map((command) => ({ command, models: { 'image-exact': model } })), problems: [] }),
            stderr: '',
            command: 'fake discovery'
          };
        }
        if (args[0] !== 'prepare') throw new Error('Тест запрещает submit/resume.');
        return prepareOffline(args);
      })
    })
  };
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('провайдеры медиа', () => {
  it('сохраняет полные объяснения всех вариантов выбора и прежнее объяснение frozen запроса', () => {
    expect(select(input, caps).modelSelection).toEqual({
      preferredModel: 'image-exact',
      selectedModel: 'image-exact',
      reason: 'Предпочтительная модель image-exact поддерживает все параметры запроса.'
    });
    expect(select({ ...input, preferredModel: null }, caps).modelSelection).toEqual({
      preferredModel: null,
      selectedModel: 'image-exact',
      reason: 'Предпочтительная модель не задана. Выбрана совместимая модель image-exact, указанная в запросе.'
    });
    expect(select({ ...input, preferredModel: null, model: '' }, caps).modelSelection).toEqual({
      preferredModel: null,
      selectedModel: 'image-exact',
      reason: 'Предпочтительная модель не задана. Выбрана совместимая модель image-exact.'
    });
    expect(select({ ...input, preferredModel: 'missing «A»\n<B>' }, caps).modelSelection).toEqual({
      preferredModel: 'missing «A»\n<B>',
      selectedModel: 'image-exact',
      reason:
        'Предпочтительная модель missing «A»\n<B> не подходит: Модель missing «A»\n<B> не объявлена для команды image_to_image. Выбрана совместимая модель image-exact.'
    });
    const previous = { preferredModel: null, selectedModel: 'image-exact', reason: 'Согласованный выбор «A»\n<B>' };
    expect(select({ ...input, preferredModel: null, modelSelection: previous }, caps).modelSelection).toEqual(previous);
  });

  it.each([
    {
      constraint: { windowSeconds: 8, rule: 'min_supported_strictly_greater_than_window' as const },
      allowed: ['9', '10'],
      expected:
        'Нет совместимой модели Тестовый сервис для команды text_to_video. video: Длительность duration=10 должна быть ближайшей поддерживаемой по правилу min_supported_strictly_greater_than_window для окна 8 с: 9 с.'
    },
    {
      constraint: { windowSeconds: 8, rule: 'min_supported_not_less_than_window' as const, minSeconds: 9 },
      allowed: ['8', '9', '10'],
      expected:
        'Нет совместимой модели Тестовый сервис для команды text_to_video. video: Длительность duration=10 должна быть ближайшей поддерживаемой по правилу min_supported_not_less_than_window для окна 8 с и не короче 9 с: 9 с.'
    },
    {
      constraint: { windowSeconds: 8, rule: 'exact_window' as const, minSeconds: 0 },
      allowed: ['10'],
      expected:
        'Нет совместимой модели Тестовый сервис для команды text_to_video. video: Длительность duration=10 должна быть ближайшей поддерживаемой по правилу exact_window для окна 8 с; подходящие длительности не объявлены.'
    },
    {
      constraint: { windowSeconds: 8, rule: 'exact_window' as const, minSeconds: 9 },
      allowed: ['8', '10'],
      expected:
        'Нет совместимой модели Тестовый сервис для команды text_to_video. video: Длительность duration=10 должна быть ближайшей поддерживаемой по правилу exact_window для окна 8 с и не короче 9 с; подходящие длительности не объявлены.'
    }
  ])('сохраняет полную диагностику длительности и отказывает до записи: $expected', async ({ constraint, allowed, expected }) => {
    const run = vi.fn(options.launcher().run);
    options.launcher = () => ({ run });
    const videoCaps: MediaCapabilities = {
      ...caps,
      kind: 'video',
      models: [{ id: 'video', command: 'text_to_video', arguments: { duration: { allowed } }, slots: {}, limits: {} }]
    };
    await expect(
      videoProvider().prepare(
        { ...input, kind: 'video', command: 'text_to_video', model: 'video', parameters: { duration: 10 }, inputs: [], durationConstraint: constraint },
        videoCaps
      )
    ).rejects.toThrowError(new Error(expected));
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(input.workDir)).toBe(false);
  });

  it('сохраняет JSON-экранирование и undefined в ошибках настроек до записи попытки', async () => {
    const run = vi.fn(options.launcher().run);
    options.launcher = () => ({ run });
    await expect(imageProvider().prepare({ ...input, parameters: { unknown: '«A»\n"B"\\C' } }, caps)).rejects.toThrowError(
      new Error(
        'Нет совместимой модели Тестовый сервис для команды image_to_image. image-exact: Параметр unknown="«A»\\n\\"B\\"\\\\C" не объявлен для модели или передаётся отдельно.'
      )
    );
    await expect(imageProvider().prepare({ ...input, parameters: { image_count: 1 }, requiredParameters: { resolution: '1k' } }, caps)).rejects.toThrowError(
      new Error(
        'Нет совместимой модели Тестовый сервис для команды image_to_image. image-exact: Параметр resolution=undefined должен совпадать с настройкой проекта "1k".'
      )
    );
    await expect(imageProvider().prepare({ ...input, projectOptions: { resolution: '«2k»' } }, caps)).rejects.toThrowError(
      new Error(
        'Нет совместимой модели Тестовый сервис для команды image_to_image. image-exact: Параметр resolution="1k" конфликтует с явной настройкой проекта "«2k»".'
      )
    );
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(input.workDir)).toBe(false);
  });

  it('сохраняет пустой состав моделей и ранний отказ неподтверждённого каталога дословно', async () => {
    const run = vi.fn(options.launcher().run);
    options.launcher = () => ({ run });
    await expect(imageProvider().prepare(input, { ...caps, available: false })).rejects.toThrowError(
      new Error('Нет подтверждённых возможностей выбранного медиа Тестовый сервис.')
    );
    await expect(imageProvider().prepare({ ...input, model: '', preferredModel: null }, { ...caps, models: [] })).rejects.toThrowError(
      new Error('Нет совместимой модели Тестовый сервис для команды image_to_image. Аккаунт не объявляет модели этой команды.')
    );
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(input.workDir)).toBe(false);
  });

  it('сохраняет сообщения запрета повторной отправки и изменения входа, не вызывая исполнителя', async () => {
    const provider = imageProvider();
    const prepared = await provider.prepare(input, caps);
    const execute = vi.fn();
    const attemptPath = join(prepared.requestDir, 'attempt.json');
    const attempt = JSON.parse(readFileSync(attemptPath, 'utf8'));
    writeFileSync(attemptPath, JSON.stringify({ ...attempt, generation_id: 'paid-once' }));
    await expect(provider.submit(prepared, execute)).rejects.toThrowError(new Error('Эта попытка уже отправлялась; продолжите её через resume.'));
    writeFileSync(attemptPath, JSON.stringify(attempt));
    writeFileSync(join(prepared.requestDir, 'prompt.txt'), 'Изменённый промпт');
    await expect(provider.submit(prepared, execute)).rejects.toThrowError(new Error('Промпт или вход изменён: требуется новая подготовка.'));
    expect(execute).not.toHaveBeenCalled();
    expect(readFileSync(join(project, 'source/reference.png'))).toEqual(png);
  });
  it('не разрешает водяной знак и явно выключает его, если модель объявляет параметр', () => {
    for (const kind of ['image', 'video'] as const) {
      const command = kind === 'image' ? 'text_to_image' : 'text_to_video';
      const request: PreparePaidInput = { ...input, kind, command, model: 'logo-model', parameters: {}, inputs: [] };
      const capabilities: MediaCapabilities = {
        ...caps,
        kind,
        models: [{ id: 'logo-model', command, arguments: { watermark: { allowed: ['true', 'false'], default: true } }, slots: {}, limits: {} }]
      };
      expect(select(request, capabilities).parameters.watermark).toBe(false);
      expect(() => select({ ...request, parameters: { watermark: true } }, capabilities)).toThrow('watermark=true');
    }
  });
  it('получает команды изображений и видео отдельными запросами вида без подставного успеха генерации', async () => {
    const run = vi.fn(options.launcher().run);
    options.launcher = () => ({ run });
    const image = await imageProvider().capabilities(project);
    const video = await videoProvider().capabilities(project);
    expect(image.available).toBe(true);
    expect(image.generationVerified).toBe(false);
    expect(image.models.map((item) => item.command)).toEqual(['text_to_image', 'image_to_image']);
    expect(video.models.map((item) => item.command)).toEqual(['text_to_video', 'image_to_video', 'omni_ref_video', 'motion_control']);
    expect(image.models[0]).toEqual({ id: 'image-exact', command: 'text_to_image', ...model });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]).toEqual([
      project,
      'media_request',
      ['capabilities', '--provider', TEST_PROVIDER, '--kind', 'image', '--json', '--timeout', '30'],
      { timeoutMs: 35_000 }
    ]);
    expect(run.mock.calls[1][2]).toEqual(['capabilities', '--provider', TEST_PROVIDER, '--kind', 'video', '--json', '--timeout', '30']);
    run.mockClear();
    await videoProvider().capabilities(project);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('две панели и повторное монтирование используют один текущий каталог', async () => {
    const run = vi.fn(options.launcher().run);
    const launcher = { run };
    options.launcher = () => launcher;
    const images = imageProvider();
    const videos = videoProvider();
    const [image, video, repeated] = await Promise.all([images.capabilities(project), videos.capabilities(project), videos.capabilities(project)]);
    // Один запрос на вид медиа: повторная панель видео ждёт уже выполняющийся.
    expect(run).toHaveBeenCalledTimes(2);
    expect(image.models.map((entry) => entry.command)).toEqual(['text_to_image', 'image_to_image']);
    expect(video.models.map((entry) => entry.command)).toEqual(['text_to_video', 'image_to_video', 'omni_ref_video', 'motion_control']);
    expect(repeated.models).toEqual(video.models);
    expect(repeated.problems).toEqual([]);
    await videos.capabilities(project);
    expect(run).toHaveBeenCalledTimes(3);
  });

  it.each([
    { code: 0, stdout: '{"ok":false}', stderr: '' },
    { code: 0, stdout: 'не JSON', stderr: '' },
    { code: 1, stdout: '', stderr: 'Общая ошибка аккаунта.' }
  ])('возвращает одну общую проблему discovery без статических моделей: %j', async (response) => {
    options.launcher = () => ({ run: vi.fn(async () => ({ ...response, command: '' })) });
    const result = await imageProvider().capabilities(project);
    expect(result.available).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.problems).toHaveLength(1);
    if (response.code !== 0) expect(result.problems).toEqual(['Общая ошибка аккаунта.']);
  });

  it('сохраняет успешные видео-команды и точную индивидуальную ошибку схемы из общего discovery', async () => {
    const report = {
      reports: ['text_to_video', 'image_to_video', 'motion_control'].map((command) => ({
        command,
        models: { 'account-video': model }
      })),
      problems: [{ command: 'omni_ref_video', message: 'Схема omni_ref_video недоступна.' }]
    };
    const run = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(report), stderr: '', command: '' }));
    options.launcher = () => ({ run });
    const result = await videoProvider().capabilities(project);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.available).toBe(true);
    expect(result.models).toEqual(['text_to_video', 'image_to_video', 'motion_control'].map((command) => ({ id: 'account-video', command, ...model })));
    expect(result.problems).toEqual(['omni_ref_video: Схема omni_ref_video недоступна.']);
    expect(result.generationVerified).toBe(false);
  });

  it.each([
    {
      reports: [
        { command: 'text_to_image', models: {} },
        { command: 'text_to_image', models: {} }
      ],
      problems: []
    },
    { reports: [{ command: 'text_to_image', models: {} }], problems: [{ command: 'image_to_image', message: '' }] },
    {
      reports: [
        { command: 'text_to_image', models: {} },
        { command: 'image_to_image', models: {} }
      ],
      problems: [{ command: 'text_to_image', message: 'Сбой.' }]
    }
  ])('отклоняет повторный состав команд или пустую ошибку команды: %j', async (report) => {
    options.launcher = () => ({ run: vi.fn(async () => ({ code: 0, stdout: JSON.stringify(report), stderr: '', command: '' })) });
    const result = await imageProvider().capabilities(project);
    expect(result.available).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/состав команд/);
  });

  it.each([
    {},
    { bad: null },
    { bad: { ...model, limits: null } },
    { bad: { ...model, arguments: { duration: { allowed: [5] } } } },
    { bad: { ...model, slots: { image: { required: 'true' } } } }
  ])('диагностирует пустые или повреждённые модели только своей команды: %j', async (invalidModels) => {
    const report = {
      reports: [
        { command: 'text_to_image', models: { 'image-exact': model } },
        { command: 'image_to_image', models: invalidModels }
      ],
      problems: []
    };
    options.launcher = () => ({ run: vi.fn(async () => ({ code: 0, stdout: JSON.stringify(report), stderr: '', command: '' })) });
    const result = await imageProvider().capabilities(project);
    expect(result.available).toBe(true);
    expect(result.models).toEqual([{ id: 'image-exact', command: 'text_to_image', ...model }]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/^image_to_image: /);
  });

  it('готовит snapshot офлайн, сохраняет SHA/входы и собирает оригинал с размером и индексом', async () => {
    const run = vi.fn(options.launcher().run);
    options.launcher = () => ({ run });
    const provider = imageProvider();
    const prepared = await provider.prepare(input, caps);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2][0]).toBe('prepare');
    expect(prepared.requestSha).toBe(hash(readFileSync(join(prepared.requestDir, 'request.json'))));
    const frozen = JSON.parse(readFileSync(join(prepared.requestDir, 'request.json'), 'utf8'));
    expect(frozen.provider).toBe(TEST_PROVIDER);
    expect(frozen.inputs[0].sha256).toBe(hash(png));
    expect(() => provider.collect(prepared)).toThrow(/ещё не сохранены/);
    writeFileSync(join(prepared.requestDir, 'original.png'), png);
    writeFileSync(
      join(prepared.requestDir, 'attempt.json'),
      JSON.stringify({
        status: 'downloaded',
        request_sha256: prepared.requestSha,
        generation_id: 'test-job',
        downloads: [{ number: 1, path: 'original.png', bytes: png.length }]
      })
    );
    expect(provider.collect(prepared)).toEqual([
      { path: join(prepared.requestDir, 'original.png'), index: 1, kind: 'image', sha256: hash(png), width: 1, height: 1, frameId: 'K01' }
    ]);
    expect(readFileSync(join(project, 'source/reference.png'))).toEqual(png);
    await expect(provider.prepare(input, caps)).rejects.toThrow();
    writeFileSync(join(prepared.requestDir, 'prompt.txt'), 'Другой промпт');
    expect(() => provider.collect(prepared)).toThrow(/Промпт или вход изменён/);
  });

  it('передаёт submit/resume только executor владельца согласования и не выдаёт артефакт до download', async () => {
    const provider = imageProvider();
    const prepared = await provider.prepare(input, caps);
    const execute = vi.fn(async () => {});
    expect(await provider.submit(prepared, execute)).toEqual({
      provider: TEST_PROVIDER,
      kind: 'image',
      requestDir: prepared.requestDir,
      requestSha: prepared.requestSha
    });
    expect(execute).toHaveBeenCalledWith('submit', prepared);
    writeFileSync(
      join(prepared.requestDir, 'attempt.json'),
      JSON.stringify({ status: 'running', generation_id: 'same-job', request_sha256: prepared.requestSha, downloads: [] })
    );
    await expect(provider.submit(prepared, execute)).rejects.toThrow(/уже отправлялась/);
    await provider.resume(prepared, execute);
    expect(execute).toHaveBeenLastCalledWith('resume', prepared);
    expect(() => provider.collect(prepared)).toThrow(/ещё не сохранены/);
  });

  it('возвращает каждый output по индексу, проверяет SHA оригиналов и запрещает внешние пути', async () => {
    const provider = imageProvider();
    const prepared = await provider.prepare({ ...input, outputs: 2, parameters: { ...input.parameters, image_count: 2 } }, caps);
    const first = join(prepared.requestDir, 'original-01.png');
    const second = join(prepared.requestDir, 'original-02.png');
    writeFileSync(first, png);
    writeFileSync(second, png);
    const attempt = {
      status: 'downloaded',
      request_sha256: prepared.requestSha,
      downloads: [
        { number: 2, path: 'original-02.png', bytes: png.length, sha256: hash(png) },
        { number: 1, path: 'original-01.png', bytes: png.length }
      ]
    };
    const save = (): void => writeFileSync(join(prepared.requestDir, 'attempt.json'), JSON.stringify(attempt));
    save();
    expect(provider.collect(prepared).map((item) => [item.index, item.path])).toEqual([
      [1, first],
      [2, second]
    ]);
    attempt.downloads[0].sha256 = 'wrong';
    save();
    expect(() => provider.collect(prepared)).toThrow(/Хеш оригинала/);
    attempt.downloads[0].sha256 = hash(png);
    attempt.downloads[0].path = '../project/source/reference.png';
    save();
    expect(() => provider.collect(prepared)).toThrow(/локальный файл/);
    expect(readFileSync(first)).toEqual(png);
  });

  it('collector отклоняет PNG под JPEG-именем без изменения оригинала', async () => {
    const provider = imageProvider();
    const prepared = await provider.prepare(input, caps);
    const path = join(prepared.requestDir, 'original.jpg');
    writeFileSync(path, png);
    writeFileSync(
      join(prepared.requestDir, 'attempt.json'),
      JSON.stringify({
        status: 'downloaded',
        request_sha256: prepared.requestSha,
        downloads: [{ number: 1, path: 'original.jpg', bytes: png.length, sha256: hash(png) }]
      })
    );
    expect(() => provider.collect(prepared)).toThrow(/Расширение оригинала не соответствует фактическому формату/);
    expect(readFileSync(path)).toEqual(png);
  });

  it('combined cap складывает legacy file arguments с массивами и не считает файл дважды через prefix', async () => {
    const provider = imageProvider();
    const legacyCaps: MediaCapabilities = {
      ...caps,
      models: [
        {
          id: input.model,
          command: input.command,
          arguments: { prompt: { required: true }, image: { required: true }, elements: { max_items: 2 } },
          slots: {},
          limits: { combined_item_cap: { maxItems: 1, arguments: ['image', 'elements'], inputPrefixes: [] } }
        }
      ]
    };
    const legacyInput: PreparePaidInput = { ...input, parameters: { elements: ['one'] }, inputs: [{ flag: 'image', path: 'source/reference.png' }] };
    await expect(provider.prepare(legacyInput, legacyCaps)).rejects.toThrow(/общий лимит/);
    const sharedPrefix = structuredClone(legacyCaps);
    sharedPrefix.models[0].limits.combined_item_cap = { maxItems: 2, arguments: ['image', 'elements'], inputPrefixes: ['image'] };
    const prepared = await provider.prepare(legacyInput, sharedPrefix);
    expect(JSON.parse(readFileSync(join(prepared.requestDir, 'request.json'), 'utf8')).inputs).toHaveLength(1);
    const namedCaps = structuredClone(caps);
    namedCaps.models[0].arguments.elements = { max_items: 2 };
    namedCaps.models[0].limits.combined_item_cap = { maxItems: 1, arguments: ['elements'], inputPrefixes: ['image_'] };
    await expect(
      provider.prepare({ ...input, parameters: { ...input.parameters, elements: ['one'] }, workDir: join(work, 'named-cap') }, namedCaps)
    ).rejects.toThrow(/общий лимит/);
  });

  it('видеоколлектор проверяет вид запроса и передаёт MP4 внедрённому валидатору', async () => {
    const videoCaps: MediaCapabilities = {
      ...caps,
      kind: 'video',
      models: [{ id: 'video-exact', command: 'text_to_video', arguments: { prompt: { required: true } }, slots: {}, limits: {} }]
    };
    const validateVideo = vi.fn(() => false);
    options.validateVideo = validateVideo;
    const provider = videoProvider();
    const prepared = await provider.prepare(
      { ...input, kind: 'video', model: 'video-exact', command: 'text_to_video', parameters: {}, inputs: [], frameId: undefined },
      videoCaps
    );
    const mp4 = Buffer.from([0, 0, 0, 24, ...Buffer.from('ftypisom'), 0, 0, 0, 0, ...Buffer.from('isomiso2')]);
    const path = join(prepared.requestDir, 'original.mp4');
    writeFileSync(path, mp4);
    writeFileSync(
      join(prepared.requestDir, 'attempt.json'),
      JSON.stringify({ status: 'downloaded', request_sha256: prepared.requestSha, downloads: [{ number: 1, path: 'original.mp4', bytes: mp4.length }] })
    );
    expect(() => provider.collect(prepared)).toThrow(/корректным видео MP4/);
    expect(validateVideo).toHaveBeenCalledWith(path);
    validateVideo.mockReturnValue(true);
    expect(provider.collect(prepared)).toEqual([{ path, index: 1, kind: 'video', sha256: hash(mp4) }]);
    expect(() => imageProvider().collect(prepared)).toThrow(/виду медиа|виду|виду|не соответствует/);
  });

  it('проверяет exact command/model, параметры, обязательные слоты и общий cap до записи', async () => {
    const provider = imageProvider();
    for (const change of [
      { command: 'text_to_image' },
      { parameters: { resolution: '8k' } },
      { parameters: { unknown: true } },
      { inputs: [] },
      { inputs: [{ flag: 'input', slot: 'unknown', path: 'source/reference.png' }] },
      { inputs: [{ flag: 'input', slot: 'image_1', path: 'https://example.test/frame.png' }] },
      { inputs: [...input.inputs, { flag: 'input', slot: 'image_2', path: 'source/reference.png' }] },
      { outputs: 2 }
    ]) {
      await expect(provider.prepare({ ...input, ...change }, caps)).rejects.toThrow();
    }
    const required = structuredClone(caps);
    required.models[0].arguments.extra = { required: true };
    await expect(provider.prepare(input, required)).rejects.toThrow(/обязательный параметр/);
    const limited = structuredClone(caps);
    limited.models[0].arguments.elements = { max_items: 1 };
    await expect(provider.prepare({ ...input, parameters: { ...input.parameters, elements: [1, 2] } }, limited)).rejects.toThrow(/число элементов/);
  });

  it('выбирает video 4 для 25 секунд, сохраняет совместимое предпочтение и объяснение в frozen spec', async () => {
    const videoCaps: MediaCapabilities = {
      ...caps,
      kind: 'video',
      models: [
        {
          id: 'video-3',
          command: 'text_to_video',
          arguments: { duration: { allowed: ['5', '10', '15'] }, resolution: { allowed: ['1080p'] } },
          slots: {},
          limits: {}
        },
        {
          id: 'video-4',
          command: 'text_to_video',
          arguments: { duration: { allowed: ['5', '10', '25'] }, resolution: { allowed: ['1080p'] } },
          slots: {},
          limits: {}
        }
      ]
    };
    const videoInput: PreparePaidInput = {
      ...input,
      kind: 'video',
      command: 'text_to_video',
      preferredModel: 'video-3',
      model: 'video-4',
      parameters: { duration: 25, resolution: '1080p' },
      inputs: []
    };
    const selected = select(videoInput, videoCaps);
    expect(selected.model).toBe('video-4');
    expect(selected.parameters).toEqual(videoInput.parameters);
    expect(selected.modelSelection.reason).toContain('duration');
    expect(selected.modelSelection.reason).toContain('25');
    expect(select(selected, videoCaps).modelSelection).toEqual(selected.modelSelection);
    const short = select({ ...videoInput, parameters: { ...videoInput.parameters, duration: 10 } }, videoCaps);
    expect(short.model).toBe('video-3');
    const noPreference = select({ ...videoInput, preferredModel: null }, videoCaps);
    expect(noPreference.model).toBe('video-4');
    expect(noPreference.modelSelection.preferredModel).toBeNull();
    const run = vi.fn(options.launcher().run);
    let frozenSpec: unknown;
    options.launcher = () => ({
      run: async (...args) => {
        frozenSpec = JSON.parse(readFileSync(args[2][2], 'utf8'));
        return run(...args);
      }
    });
    await videoProvider().prepare(selected, videoCaps);
    expect(frozenSpec).toMatchObject({ model: 'video-4', parameters: { duration: 25, resolution: '1080p' }, model_selection: selected.modelSelection });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2][0]).toBe('prepare');
  });

  it('при отсутствии совместимых моделей не вызывает runner и не создаёт попытку', async () => {
    const run = vi.fn(options.launcher().run);
    options.launcher = () => ({ run });
    await expect(imageProvider().prepare({ ...input, parameters: { resolution: '8k' } }, caps)).rejects.toThrow('"8k"');
    expect(run).not.toHaveBeenCalled();
    expect(existsSync(input.workDir)).toBe(false);
  });

  it('сохраняет fallback по правилу ближайшей длительности до frozen prepare', async () => {
    const videoCaps: MediaCapabilities = {
      ...caps,
      kind: 'video',
      models: [
        { id: 'video-3', command: 'text_to_video', arguments: { duration: { allowed: ['9', '10'] } }, slots: {}, limits: {} },
        { id: 'video-4', command: 'text_to_video', arguments: { duration: { allowed: ['10'] } }, slots: {}, limits: {} }
      ]
    };
    const videoInput: PreparePaidInput = {
      ...input,
      kind: 'video',
      command: 'text_to_video',
      model: 'video-4',
      preferredModel: 'video-3',
      durationConstraint: { windowSeconds: 8, rule: 'min_supported_strictly_greater_than_window' },
      parameters: { duration: 10 },
      inputs: []
    };
    const selected = select(videoInput, videoCaps);
    expect(selected.model).toBe('video-4');
    expect(selected.modelSelection.reason).toContain('ближайшей');
    expect(selected.modelSelection.reason).toContain('9 с');
    const prepared = await videoProvider().prepare(selected, videoCaps);
    const frozen = JSON.parse(readFileSync(join(prepared.requestDir, 'request.json'), 'utf8'));
    expect(frozen).toMatchObject({ model: 'video-4', parameters: { duration: 10 }, model_selection: selected.modelSelection });
    expect(frozen).not.toHaveProperty('durationConstraint');
    expect(frozen).not.toHaveProperty('duration_constraint');
  });

  it('сохраняет обязательные project options, проверяет aliases и не теряет их до frozen request', async () => {
    const optionCaps = structuredClone(caps);
    optionCaps.models[0].arguments.enable_audio = { allowed: ['true', 'false'], default: 'true' };
    const requested: PreparePaidInput = { ...input, projectOptions: { enableAudio: false } };
    const selected = select(requested, optionCaps);
    expect(selected.parameters.enable_audio).toBe(false);
    const prepared = await imageProvider().prepare(selected, optionCaps);
    const frozen = JSON.parse(readFileSync(join(prepared.requestDir, 'request.json'), 'utf8'));
    expect(frozen.parameters.enable_audio).toBe(false);
    expect(frozen).not.toHaveProperty('projectOptions');
    expect(frozen).not.toHaveProperty('requiredParameters');
    expect(select({ ...requested, parameters: { ...input.parameters, enable_audio: false } }, optionCaps).parameters.enable_audio).toBe(false);
    expect(() => select({ ...requested, parameters: { ...input.parameters, enable_audio: true } }, optionCaps)).toThrow('конфликтует');
    expect(() => select(requested, caps)).toThrow('enableAudio=false');
  });

  it('учитывает настройки проекта при выборе каждого кандидата без добавления отсутствующего aspect', () => {
    const preferred = { ...caps.models[0], id: 'preferred', arguments: { ...caps.models[0].arguments, aspect_ratio: { allowed: ['16:9'] } } };
    const selected = select(
      { ...input, preferredModel: 'preferred', requiredParameters: { resolution: '1k', aspect_ratio: '16:9' } },
      { ...caps, models: [preferred, ...caps.models] }
    );
    expect(selected.model).toBe(input.model);
    expect(selected.parameters).not.toHaveProperty('aspect_ratio');
    expect(selected.modelSelection.reason).toContain('aspect_ratio');
    expect(selected.modelSelection.reason).toContain('16:9');
  });

  it('пропорции ролика с начальным кадром задаёт кадр: aspect_ratio можно не передавать, а кадр сверяется с проектом', () => {
    const adapter = { ...testPaidAdapter, rules: { ...testPaidAdapter.rules, frameDefined: { slots: /^first_image$/, parameters: ['aspect_ratio'] } } };
    const videoCaps: MediaCapabilities = {
      ...caps,
      kind: 'video',
      models: [
        {
          id: 'keyframes',
          command: 'image_to_video',
          arguments: { prompt: { required: true }, aspect_ratio: { allowed: ['16:9', '1:1'] } },
          slots: { first_image: { required: true } },
          limits: {}
        }
      ]
    };
    // Размеры PNG читаются из заголовка IHDR: кадр 1920×1080 соответствует 16:9.
    const wide = Buffer.from(png);
    wide.writeUInt32BE(1920, 16);
    wide.writeUInt32BE(1080, 20);
    writeFileSync(join(project, 'source/wide.png'), wide);
    const request: PreparePaidInput = {
      ...input,
      kind: 'video',
      command: 'image_to_video',
      model: 'keyframes',
      parameters: {},
      inputs: [{ flag: 'input', slot: 'first_image', path: 'source/wide.png', role: 'first' }],
      requiredParameters: { aspect_ratio: '16:9' }
    };
    expect(selectPaidRequest(adapter, request, videoCaps).parameters).not.toHaveProperty('aspect_ratio');
    // Переданный параметр по-прежнему обязан совпадать с настройкой проекта.
    expect(() => selectPaidRequest(adapter, { ...request, parameters: { aspect_ratio: '1:1' } }, videoCaps)).toThrow('должен совпадать');
    // Без правила провайдера настройка проекта остаётся обязательным параметром.
    expect(() => select(request, videoCaps)).toThrow('должен совпадать');
    expect(() => selectPaidRequest(adapter, { ...request, inputs: [{ ...request.inputs[0], path: 'source/reference.png' }] }, videoCaps)).toThrow(
      'не совпадает с пропорциями проекта 16:9'
    );
  });

  it('отсутствующее предпочтение допускает exact fallback и blank автоматически выбирает модель', () => {
    const selected = select({ ...input, model: 'image-alias' }, caps);
    expect(selected.model).toBe('image-exact');
    expect(selected.modelSelection.reason).toContain('image-alias не объявлена');
    expect(select({ ...input, model: '  ' }, caps).model).toBe('image-exact');
  });

  it('принимает camelCase только как написание объявленного MCP-параметра и сохраняет объявленное имя', async () => {
    const provider = imageProvider();
    const prepared = await provider.prepare({ ...input, parameters: { resolution: '1k', imageCount: 1 } }, caps);
    const frozen = JSON.parse(readFileSync(join(prepared.requestDir, 'request.json'), 'utf8'));
    expect(frozen.parameters).toEqual({ resolution: '1k', image_count: 1 });
    await expect(provider.prepare({ ...input, workDir: join(work, 'duplicate'), parameters: { imageCount: 1, image_count: 1 } }, caps)).rejects.toThrow(
      /указан дважды/
    );
  });

  it('раскрывает legacy image/tailImage в точные объявленные first/tail slots до фиксации запроса', async () => {
    const provider = videoProvider();
    const videoCaps: MediaCapabilities = {
      ...caps,
      kind: 'video',
      models: [
        {
          id: 'video-exact',
          command: 'image_to_video',
          arguments: { prompt: { required: true } },
          slots: { first_image: { required: true }, tail_image: { required: false } },
          limits: { combined_item_cap: { maxItems: 2, arguments: [], inputPrefixes: ['first_image', 'tail_image'] } }
        }
      ]
    };
    const videoInput: PreparePaidInput = {
      ...input,
      kind: 'video',
      command: 'image_to_video',
      model: 'video-exact',
      parameters: {},
      inputs: [
        { flag: 'image', path: 'source/reference.png', role: 'first' },
        { flag: 'tailImage', path: 'source/reference.png', role: 'last' }
      ]
    };
    const prepared = await provider.prepare(videoInput, videoCaps);
    const frozen = JSON.parse(readFileSync(join(prepared.requestDir, 'request.json'), 'utf8'));
    expect(frozen.inputs.map((item: { flag: string; slot: string; role: string }) => [item.flag, item.slot, item.role])).toEqual([
      ['input', 'first_image', 'first'],
      ['input', 'tail_image', 'last']
    ]);
    expect(frozen.inputs).toHaveLength(2);
    const limited = structuredClone(videoCaps);
    limited.models[0].limits.combined_item_cap = { maxItems: 1, arguments: [], inputPrefixes: ['first_image', 'tail_image'] };
    await expect(provider.prepare(videoInput, limited)).rejects.toThrow(/общий лимит/);
    await expect(provider.prepare({ ...videoInput, inputs: [videoInput.inputs[1]] }, videoCaps)).rejects.toThrow(/обязательный слот first_image/);
    await expect(
      provider.prepare({ ...videoInput, inputs: [videoInput.inputs[0], { flag: 'input', slot: 'tail_image', path: 'source/reference.png' }] }, videoCaps)
    ).rejects.toThrow(/Не смешивайте/);
  });

  it('раскрывает omni image/audio/video по объявленному порядку и требует named inputs для неизвестных ролей', async () => {
    const provider = videoProvider();
    const omniCaps: MediaCapabilities = {
      ...caps,
      kind: 'video',
      models: [
        {
          id: 'omni-exact',
          command: 'omni_ref_video',
          arguments: { prompt: { required: true } },
          slots: { image_2: { required: true }, image_1: {}, audio_1: {}, video_1: {} },
          limits: {}
        }
      ]
    };
    const source = 'source/reference.png';
    const omniInput: PreparePaidInput = {
      ...input,
      kind: 'video',
      command: 'omni_ref_video',
      model: 'omni-exact',
      parameters: {},
      inputs: [
        { flag: 'image', path: source },
        { flag: 'image', path: source },
        { flag: 'audio', path: source },
        { flag: 'video', path: source }
      ]
    };
    const prepared = await provider.prepare(omniInput, omniCaps);
    const frozen = JSON.parse(readFileSync(join(prepared.requestDir, 'request.json'), 'utf8'));
    expect(frozen.inputs.map((item: { slot: string }) => item.slot)).toEqual(['image_2', 'image_1', 'audio_1', 'video_1']);
    const ambiguous = structuredClone(omniCaps);
    ambiguous.models[0].slots = { reference: { required: true } };
    await expect(provider.prepare(omniInput, ambiguous)).rejects.toThrow(/именованные input slots/);
  });
});
