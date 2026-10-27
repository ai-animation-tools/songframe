import { KLING_COMMANDS } from './kling-capabilities';
/** Транспорт проверяется подставным discovery и настоящей локальной prepare без Kling CLI и сети. */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaCapabilities } from '@shared/media-providers';
import type { AgentJob } from '@shared/agents';
import { KeyframeImages } from './keyframe-images';
import {
  CodexImageProvider,
  KlingImageProvider,
  KlingVideoProvider,
  selectKlingRequest,
  type MediaProviderOptions,
  type PrepareKlingInput
} from './media-providers';
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/l9sAAAAASUVORK5CYII=', 'base64');
let work: string;
let project: string;
let options: MediaProviderOptions;
let input: PrepareKlingInput;
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
    provider: 'kling',
    kind: 'image',
    checkedAt: new Date().toISOString(),
    available: true,
    generationVerified: false,
    models: [{ ...model, id: input.model, command: input.command }],
    problems: []
  };
  options = {
    cliArgs: () => ['--cli', '/unused/test-kling'],
    checkCodex: async () => ({ availability: 'available', authorization: 'authenticated', message: 'Готово' }),
    images: new KeyframeImages({ localDir: join(work, 'state'), agents: { startImages: vi.fn() } }),
    launcher: () => ({
      run: vi.fn(async (_project, _tool, args) => {
        if (args[0] === 'capabilities')
          return {
            code: 0,
            stdout: JSON.stringify({ reports: args[2].split(',').map((command: string) => ({ command, models: { 'image-exact': model } })), problems: [] }),
            stderr: '',
            command: 'fake discovery'
          };
        if (args[0] !== 'prepare') throw new Error('Тест запрещает CLI/submit/resume.');
        const result = spawnSync('python3', ['-B', resolve('tools/kling_request/kling_request.py'), ...args], {
          encoding: 'utf8',
          env: { ...process.env, SONGFRAME_PROJECT: project }
        });
        return { code: result.status, stdout: result.stdout, stderr: result.stderr, command: 'offline prepare' };
      })
    })
  };
});
afterEach(() => rmSync(work, { recursive: true, force: true }));

describe('провайдеры медиа', () => {
  it('не разрешает водяной знак и явно выключает его, если модель объявляет параметр', () => {
    for (const kind of ['image', 'video'] as const) {
      const command = kind === 'image' ? 'text_to_image' : 'text_to_video';
      const request: PrepareKlingInput = { ...input, kind, command, model: 'logo-model', parameters: {}, inputs: [] };
      const capabilities: MediaCapabilities = {
        ...caps,
        kind,
        models: [{ id: 'logo-model', command, arguments: { watermark: { allowed: ['true', 'false'], default: true } }, slots: {}, limits: {} }]
      };
      expect(selectKlingRequest(request, capabilities).parameters.watermark).toBe(false);
      expect(() => selectKlingRequest({ ...request, parameters: { watermark: true } }, capabilities)).toThrow('watermark=true');
    }
  });
  it('получает две команды изображений и четыре видео без подставного успеха генерации', async () => {
    const run = vi.fn(options.launcher().run);
    options.launcher = () => ({ run });
    const image = await new KlingImageProvider(options).capabilities(project);
    const video = await new KlingVideoProvider(options).capabilities(project);
    expect(image.available).toBe(true);
    expect(image.generationVerified).toBe(false);
    expect(image.models.map((item) => item.command)).toEqual(['text_to_image', 'image_to_image']);
    expect(video.models.map((item) => item.command)).toEqual(['text_to_video', 'image_to_video', 'omni_ref_video', 'motion_control']);
    expect(image.models[0]).toEqual({ id: 'image-exact', command: 'text_to_image', ...model });
    expect(run).toHaveBeenCalledTimes(2);
    expect(run.mock.calls[0]).toEqual([
      project,
      'kling_request',
      ['capabilities', '--commands', KLING_COMMANDS.join(','), '--json', '--timeout', '30', '--cli', '/unused/test-kling'],
      { timeoutMs: 35_000 }
    ]);
    expect(run.mock.calls[1][2]).toEqual(['capabilities', '--commands', KLING_COMMANDS.join(','), '--json', '--timeout', '30', '--cli', '/unused/test-kling']);
    run.mockClear();
    await new KlingVideoProvider(options).capabilities(project);
    expect(run).toHaveBeenCalledTimes(1);
  });

  it('две панели Kling и повторное монтирование используют один текущий каталог', async () => {
    const run = vi.fn(options.launcher().run);
    const launcher = { run };
    options.launcher = () => launcher;
    const imageProvider = new KlingImageProvider(options);
    const videoProvider = new KlingVideoProvider(options);
    const [image, video, repeated] = await Promise.all([
      imageProvider.capabilities(project),
      videoProvider.capabilities(project),
      videoProvider.capabilities(project)
    ]);
    expect(run).toHaveBeenCalledTimes(1);
    expect(image.models.map((entry) => entry.command)).toEqual(['text_to_image', 'image_to_image']);
    expect(video.models.map((entry) => entry.command)).toEqual(['text_to_video', 'image_to_video', 'omni_ref_video', 'motion_control']);
    expect(repeated.models).toEqual(video.models);
    expect(repeated.problems).toEqual([]);
    await videoProvider.capabilities(project);
    expect(run).toHaveBeenCalledTimes(2);
  });

  it.each([
    { code: 0, stdout: '{"ok":false}', stderr: '' },
    { code: 0, stdout: 'не JSON', stderr: '' },
    { code: 1, stdout: '', stderr: 'Общая ошибка аккаунта.' }
  ])('возвращает одну общую проблему discovery без статических моделей: %j', async (response) => {
    options.launcher = () => ({ run: vi.fn(async () => ({ ...response, command: '' })) });
    const result = await new KlingImageProvider(options).capabilities(project);
    expect(result.available).toBe(false);
    expect(result.models).toEqual([]);
    expect(result.problems).toHaveLength(1);
    if (response.code !== 0) expect(result.problems).toEqual(['Общая ошибка аккаунта.']);
  });

  it('сохраняет успешные видео-команды и точную индивидуальную ошибку схемы из общего discovery', async () => {
    const report = {
      reports: ['text_to_image', 'image_to_image', 'motion_control', 'image_to_video', 'text_to_video'].map((command) => ({
        command,
        models: { 'account-video': model }
      })),
      problems: [{ command: 'omni_ref_video', message: 'Схема omni_ref_video недоступна.' }]
    };
    const run = vi.fn(async () => ({ code: 0, stdout: JSON.stringify(report), stderr: '', command: '' }));
    options.launcher = () => ({ run });
    const result = await new KlingVideoProvider(options).capabilities(project);
    expect(run).toHaveBeenCalledTimes(1);
    expect(result.available).toBe(true);
    expect(result.models).toEqual(['text_to_video', 'image_to_video', 'motion_control'].map((command) => ({ id: 'account-video', command, ...model })));
    expect(result.problems).toEqual(['omni_ref_video: Схема omni_ref_video недоступна.']);
    expect(result.generationVerified).toBe(false);
  });

  it.each([
    { reports: [{ command: 'text_to_image', models: {} }], problems: [] },
    {
      reports: [
        { command: 'text_to_image', models: {} },
        { command: 'text_to_image', models: {} }
      ],
      problems: []
    },
    {
      reports: [
        { command: 'text_to_image', models: {} },
        { command: 'text_to_video', models: {} }
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
  ])('отклоняет неполный, повторный или чужой состав команд: %j', async (report) => {
    options.launcher = () => ({ run: vi.fn(async () => ({ code: 0, stdout: JSON.stringify(report), stderr: '', command: '' })) });
    const result = await new KlingImageProvider(options).capabilities(project);
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
        ...KLING_COMMANDS.filter((command) => command !== 'image_to_image').map((command) => ({ command, models: { 'image-exact': model } })),
        { command: 'image_to_image', models: invalidModels }
      ],
      problems: []
    };
    options.launcher = () => ({ run: vi.fn(async () => ({ code: 0, stdout: JSON.stringify(report), stderr: '', command: '' })) });
    const result = await new KlingImageProvider(options).capabilities(project);
    expect(result.available).toBe(true);
    expect(result.models).toEqual([{ id: 'image-exact', command: 'text_to_image', ...model }]);
    expect(result.problems).toHaveLength(1);
    expect(result.problems[0]).toMatch(/^image_to_image: /);
  });

  it('готовит snapshot офлайн, сохраняет SHA/входы и собирает оригинал с размером и индексом', async () => {
    const run = vi.fn(options.launcher().run);
    options.launcher = () => ({ run });
    const provider = new KlingImageProvider(options);
    const prepared = await provider.prepare(input, caps);
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2][0]).toBe('prepare');
    expect(prepared.requestSha).toBe(hash(readFileSync(join(prepared.requestDir, 'request.json'))));
    const frozen = JSON.parse(readFileSync(join(prepared.requestDir, 'request.json'), 'utf8'));
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
    const provider = new KlingImageProvider(options);
    const prepared = await provider.prepare(input, caps);
    const execute = vi.fn(async () => {});
    expect(await provider.submit(prepared, execute)).toEqual({
      provider: 'kling',
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
    const provider = new KlingImageProvider(options);
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

  it('Kling collector отклоняет PNG под JPEG-именем без изменения оригинала', async () => {
    const provider = new KlingImageProvider(options);
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
    const provider = new KlingImageProvider(options);
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
    const legacyInput: PrepareKlingInput = { ...input, parameters: { elements: ['one'] }, inputs: [{ flag: 'image', path: 'source/reference.png' }] };
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
    const provider = new KlingVideoProvider(options);
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
    expect(() => new KlingImageProvider(options).collect(prepared)).toThrow(/виду медиа|виду|виду|не соответствует/);
  });

  it('проверяет exact command/model, параметры, обязательные слоты и общий cap до записи', async () => {
    const provider = new KlingImageProvider(options);
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
    const videoInput: PrepareKlingInput = {
      ...input,
      kind: 'video',
      command: 'text_to_video',
      preferredModel: 'video-3',
      model: 'video-4',
      parameters: { duration: 25, resolution: '1080p' },
      inputs: []
    };
    const selected = selectKlingRequest(videoInput, videoCaps);
    expect(selected.model).toBe('video-4');
    expect(selected.parameters).toEqual(videoInput.parameters);
    expect(selected.modelSelection.reason).toContain('duration');
    expect(selected.modelSelection.reason).toContain('25');
    expect(selectKlingRequest(selected, videoCaps).modelSelection).toEqual(selected.modelSelection);
    const short = selectKlingRequest({ ...videoInput, parameters: { ...videoInput.parameters, duration: 10 } }, videoCaps);
    expect(short.model).toBe('video-3');
    const noPreference = selectKlingRequest({ ...videoInput, preferredModel: null }, videoCaps);
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
    await new KlingVideoProvider(options).prepare(selected, videoCaps);
    expect(frozenSpec).toMatchObject({ model: 'video-4', parameters: { duration: 25, resolution: '1080p' }, model_selection: selected.modelSelection });
    expect(run).toHaveBeenCalledTimes(1);
    expect(run.mock.calls[0][2][0]).toBe('prepare');
  });

  it('при отсутствии совместимых моделей не вызывает runner и не создаёт попытку', async () => {
    const run = vi.fn(options.launcher().run);
    options.launcher = () => ({ run });
    await expect(new KlingImageProvider(options).prepare({ ...input, parameters: { resolution: '8k' } }, caps)).rejects.toThrow('"8k"');
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
    const videoInput: PrepareKlingInput = {
      ...input,
      kind: 'video',
      command: 'text_to_video',
      model: 'video-4',
      preferredModel: 'video-3',
      durationConstraint: { windowSeconds: 8, rule: 'min_supported_strictly_greater_than_window' },
      parameters: { duration: 10 },
      inputs: []
    };
    const selected = selectKlingRequest(videoInput, videoCaps);
    expect(selected.model).toBe('video-4');
    expect(selected.modelSelection.reason).toContain('ближайшей');
    expect(selected.modelSelection.reason).toContain('9 с');
    const prepared = await new KlingVideoProvider(options).prepare(selected, videoCaps);
    const frozen = JSON.parse(readFileSync(join(prepared.requestDir, 'request.json'), 'utf8'));
    expect(frozen).toMatchObject({ model: 'video-4', parameters: { duration: 10 }, model_selection: selected.modelSelection });
    expect(frozen).not.toHaveProperty('durationConstraint');
    expect(frozen).not.toHaveProperty('duration_constraint');
  });

  it('сохраняет обязательные project options, проверяет aliases и не теряет их до frozen request', async () => {
    const optionCaps = structuredClone(caps);
    optionCaps.models[0].arguments.enable_audio = { allowed: ['true', 'false'], default: 'true' };
    const requested: PrepareKlingInput = { ...input, projectOptions: { enableAudio: false } };
    const selected = selectKlingRequest(requested, optionCaps);
    expect(selected.parameters.enable_audio).toBe(false);
    const prepared = await new KlingImageProvider(options).prepare(selected, optionCaps);
    const frozen = JSON.parse(readFileSync(join(prepared.requestDir, 'request.json'), 'utf8'));
    expect(frozen.parameters.enable_audio).toBe(false);
    expect(frozen).not.toHaveProperty('projectOptions');
    expect(frozen).not.toHaveProperty('requiredParameters');
    expect(selectKlingRequest({ ...requested, parameters: { ...input.parameters, enable_audio: false } }, optionCaps).parameters.enable_audio).toBe(false);
    expect(() => selectKlingRequest({ ...requested, parameters: { ...input.parameters, enable_audio: true } }, optionCaps)).toThrow('конфликтует');
    expect(() => selectKlingRequest(requested, caps)).toThrow('enableAudio=false');
  });

  it('учитывает настройки проекта при выборе каждого кандидата без добавления отсутствующего aspect', () => {
    const preferred = { ...caps.models[0], id: 'preferred', arguments: { ...caps.models[0].arguments, aspect_ratio: { allowed: ['16:9'] } } };
    const selected = selectKlingRequest(
      { ...input, preferredModel: 'preferred', requiredParameters: { resolution: '1k', aspect_ratio: '16:9' } },
      { ...caps, models: [preferred, ...caps.models] }
    );
    expect(selected.model).toBe(input.model);
    expect(selected.parameters).not.toHaveProperty('aspect_ratio');
    expect(selected.modelSelection.reason).toContain('aspect_ratio');
    expect(selected.modelSelection.reason).toContain('16:9');
  });

  it('отсутствующее предпочтение допускает exact fallback и blank автоматически выбирает модель', () => {
    const selected = selectKlingRequest({ ...input, model: 'image-alias' }, caps);
    expect(selected.model).toBe('image-exact');
    expect(selected.modelSelection.reason).toContain('image-alias не объявлена');
    expect(selectKlingRequest({ ...input, model: '  ' }, caps).model).toBe('image-exact');
  });

  it('принимает camelCase только как написание объявленного MCP-параметра и сохраняет объявленное имя', async () => {
    const provider = new KlingImageProvider(options);
    const prepared = await provider.prepare({ ...input, parameters: { resolution: '1k', imageCount: 1 } }, caps);
    const frozen = JSON.parse(readFileSync(join(prepared.requestDir, 'request.json'), 'utf8'));
    expect(frozen.parameters).toEqual({ resolution: '1k', image_count: 1 });
    await expect(provider.prepare({ ...input, workDir: join(work, 'duplicate'), parameters: { imageCount: 1, image_count: 1 } }, caps)).rejects.toThrow(
      /указан дважды/
    );
  });

  it('раскрывает legacy image/tailImage в точные объявленные first/tail slots до фиксации запроса', async () => {
    const provider = new KlingVideoProvider(options);
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
    const videoInput: PrepareKlingInput = {
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
    const provider = new KlingVideoProvider(options);
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
    const omniInput: PrepareKlingInput = {
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

  it('Codex после перезапуска восстанавливает SHA из job.json и поддерживает legacy без frozen proof', () => {
    const productionInput = {
      project,
      shot: 'M01',
      packageDir: input.workDir,
      frames: [{ id: 'K01', role: 'first' as const, timeSeconds: 0, prompt: 'Кадр', referencePaths: [] }]
    };
    const job = {
      id: 'persisted-agent',
      project,
      provider: 'codex',
      status: 'completed',
      exitCode: 0,
      result: JSON.stringify({ schemaVersion: 1, stage: 'frames', images: [{ id: 'K01', path: 'K01.png' }] })
    } as AgentJob;
    const localDir = join(work, 'restart-state');
    const createImages = (): KeyframeImages =>
      new KeyframeImages({
        localDir,
        agents: {
          startImages: (_input, directory) => {
            writeFileSync(join(directory, 'K01.png'), png);
            return job;
          }
        }
      });
    options.images = createImages();
    const initial = new CodexImageProvider(options);
    const prepared = initial.prepare(productionInput);
    initial.submit(prepared, { requestSha: prepared.requestSha });
    options.images = createImages();
    expect(options.images.getRequestSha(job)).toBe(prepared.requestSha);
    expect(new CodexImageProvider(options).collectJob(job)).toMatchObject([{ index: 1, frameId: 'K01', kind: 'image', width: 1, height: 1 }]);
    const legacy = { ...job, id: 'legacy-agent' };
    options.images = new KeyframeImages({
      localDir,
      agents: {
        startImages: (_input, directory) => {
          writeFileSync(join(directory, 'K01.png'), png);
          return legacy;
        }
      }
    });
    options.images.start(productionInput);
    options.images = new KeyframeImages({ localDir, agents: { startImages: vi.fn() } });
    expect(options.images.getRequestSha(legacy)).toBeNull();
    expect(new CodexImageProvider(options).collectJob(legacy)).toMatchObject([{ index: 1, frameId: 'K01', kind: 'image' }]);
  });

  it('Codex проверяет CLI, но не сообщает о подтверждённом image tool и не запускает его при discovery/prepare', async () => {
    const start = vi.spyOn(options.images, 'start');
    const provider = new CodexImageProvider(options);
    const capabilities = await provider.capabilities(project);
    expect(capabilities).toMatchObject({ available: true, models: [], generationVerified: false });
    expect(capabilities.problems).toEqual([]);
    const prepared = provider.prepare({
      project,
      shot: 'M01',
      packageDir: input.workDir,
      frames: [{ id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Первый кадр', referencePaths: ['source/reference.png'] }]
    });
    expect(prepared.references[0].sha256).toBe(hash(png));
    expect(start).not.toHaveBeenCalled();
    expect(() => provider.submit(prepared, { requestSha: 'wrong' })).toThrow(/изменились/);
    writeFileSync(join(project, 'source/reference.png'), Buffer.concat([png, Buffer.from('изменено')]));
    expect(() => provider.submit(prepared, { requestSha: prepared.requestSha })).toThrow(/изменились/);
    expect(start).not.toHaveBeenCalled();
  });

  it('Codex discovery загружает реальный каталог моделей агента, не подтверждая image tool', async () => {
    const models = [{ id: 'account-model', command: 'codex_exec', arguments: {}, slots: {}, limits: {} }];
    options.listCodexModels = vi.fn(async () => models);
    const start = vi.spyOn(options.images, 'start');
    const result = await new CodexImageProvider(options).capabilities(project);
    expect(result).toMatchObject({ available: true, models, generationVerified: false, problems: [] });
    expect(options.listCodexModels).toHaveBeenCalledTimes(1);
    expect(start).not.toHaveBeenCalled();
  });

  it('сбой каталога Codex не превращается в отсутствие CLI; недоступный CLI каталог не запрашивает', async () => {
    options.listCodexModels = vi.fn(async () => {
      throw new Error('fixture network failure');
    });
    const provider = new CodexImageProvider(options);
    expect(await provider.capabilities(project)).toMatchObject({
      available: true,
      models: [],
      generationVerified: false,
      problems: ['Каталог моделей агента Codex сейчас недоступен. Повторите проверку возможностей.']
    });
    options.checkCodex = async () => ({ availability: 'not_found', authorization: 'unknown', message: 'CLI не найден.' });
    expect(await provider.capabilities(project)).toMatchObject({ available: false, models: [], generationVerified: false, problems: ['CLI не найден.'] });
    expect(options.listCodexModels).toHaveBeenCalledTimes(1);
  });

  it('Codex расходует prepared и permit один раз, сохраняя возможность нового явного запуска тех же входов', () => {
    const provider = new CodexImageProvider(options);
    const source = {
      project,
      shot: 'M01',
      packageDir: input.workDir,
      frames: [{ id: 'K01', role: 'first' as const, timeSeconds: 0, prompt: 'Кадр', referencePaths: [] }]
    };
    const prepared = provider.prepare(source);
    const permit = { requestSha: prepared.requestSha };
    const start = vi.spyOn(options.images, 'start').mockReturnValue({ id: 'agent-job' } as AgentJob);
    provider.submit(prepared, permit);
    expect(() => provider.submit(prepared, permit)).toThrow(/уже использованы/);
    expect(() => provider.submit(prepared, { requestSha: prepared.requestSha })).toThrow(/уже использованы/);
    const next = provider.prepare(source);
    expect(next.requestSha).toBe(prepared.requestSha);
    expect(() => provider.submit(next, permit)).toThrow(/уже использованы/);
    expect(start).toHaveBeenCalledTimes(1);
    provider.submit(next, { requestSha: next.requestSha });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('Codex после ошибки start требует новую подготовку и новый permit', () => {
    const provider = new CodexImageProvider(options);
    const source = {
      project,
      shot: 'M01',
      packageDir: input.workDir,
      frames: [{ id: 'K01', role: 'first' as const, timeSeconds: 0, prompt: 'Кадр', referencePaths: [] }]
    };
    const prepared = provider.prepare(source);
    const permit = { requestSha: prepared.requestSha };
    const start = vi
      .spyOn(options.images, 'start')
      .mockImplementationOnce(() => {
        throw new Error('Не удалось запустить CLI');
      })
      .mockReturnValue({ id: 'retry-job' } as AgentJob);
    expect(() => provider.submit(prepared, permit)).toThrow(/Не удалось запустить CLI/);
    expect(() => provider.submit(prepared, { requestSha: prepared.requestSha })).toThrow(/уже использованы/);
    const retry = provider.prepare(source);
    expect(() => provider.submit(retry, permit)).toThrow(/уже использованы/);
    expect(start).toHaveBeenCalledTimes(1);
    provider.submit(retry, { requestSha: retry.requestSha });
    expect(start).toHaveBeenCalledTimes(2);
  });

  it('Codex связывает задание с requestSHA и собирает результат через существующий collector', () => {
    const provider = new CodexImageProvider(options);
    const prepared = provider.prepare({
      project,
      shot: 'M01',
      packageDir: input.workDir,
      frames: [{ id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Кадр', referencePaths: [] }]
    });
    const job = { id: 'agent-job' } as AgentJob;
    const start = vi.spyOn(options.images, 'start').mockReturnValue(job);
    const ref = provider.submit(prepared, { requestSha: prepared.requestSha });
    expect(start).toHaveBeenCalledWith(prepared.input, prepared.requestSha);
    const file = join(work, 'image.png');
    writeFileSync(file, png);
    const collect = vi.spyOn(options.images, 'collect').mockReturnValue([{ id: 'K01', path: file }]);
    if (ref.provider !== 'codex') throw new Error('Неверный исполнитель');
    expect(provider.collect(ref, job)).toEqual([{ path: file, frameId: 'K01', index: 1, kind: 'image', sha256: hash(png), width: 1, height: 1 }]);
    expect(collect).toHaveBeenCalledWith(job, prepared.requestSha);
  });
});
