/** Адаптер Kling: проверка поставки клиента без сети и правила запроса для общего платного адаптера. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { MediaCapabilities } from '@shared/media-providers';
import { frameImageRequest } from '../../frame-image-request';
import { selectPaidRequest, type PreparePaidInput } from '../../media-providers';
import { PythonLauncher } from '../../python-launcher';
import { kling } from '.';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-kling-adapter-'));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

const caps = (kind: 'image' | 'video', command: string, model: MediaCapabilities['models'][number]['arguments'], slots = {}): MediaCapabilities => ({
  provider: kling.id,
  kind,
  available: true,
  checkedAt: '',
  generationVerified: false,
  problems: [],
  models: [{ id: 'model', command, arguments: model, slots, limits: {} }]
});

describe('Поставка клиента Kling', () => {
  it('smoke-проверка импортирует клиент, хранит токены в каталоге состояния и не ходит в сеть', async () => {
    const localDir = join(work, 'state с пробелами');
    // Недоступный адрес: при попытке сетевого вызова проверка упала бы с неизвестным состоянием входа.
    const env = { ...process.env, SONGFRAME_KLING_BASE_URL: 'http://127.0.0.1:9', SONGFRAME_PROJECT: '' };
    const launcher = new PythonLauncher({ toolsRoot: resolve('.'), localDir, env });
    const [check] = kling.smokeChecks(launcher.options);
    const result = await launcher.execute(['-c', check.code], { timeoutMs: 60000 });
    expect(result.code, result.stderr).toBe(0);
    expect(JSON.parse(result.stdout)).toEqual({
      credentials: join('providers', 'kling', 'credentials.json'),
      authStatus: 'unauthenticated',
      networkUsed: false
    });
  });
});

describe('Правила запроса Kling', () => {
  const base: PreparePaidInput = {
    project: '/project',
    workDir: '/project/request',
    shot: 'M01',
    kind: 'image',
    command: 'text_to_image',
    model: 'model',
    prompt: 'Кадр.',
    parameters: {},
    inputs: [],
    outputs: 1
  };

  it('запрашивает оригинал без логотипа и не принимает watermark=true', () => {
    const capabilities = caps('image', 'text_to_image', { watermark: { allowed: ['true', 'false'] } });
    expect(selectPaidRequest(kling, base, capabilities).parameters.watermark).toBe(false);
    expect(() => selectPaidRequest(kling, { ...base, parameters: { watermark: true } }, capabilities)).toThrow('watermark=true');
  });

  it('считает resolution и img_resolution одним параметром изображения и задаёт число результатов через image_count', () => {
    const capabilities = caps('image', 'text_to_image', { img_resolution: { allowed: ['2k'] }, image_count: { allowed: ['1', '2'] } });
    const selected = selectPaidRequest(kling, { ...base, outputs: 2, parameters: { resolution: '2k' } }, capabilities);
    expect(selected.parameters).toEqual({ img_resolution: '2k', image_count: 2 });
  });

  it('раскрывает короткие флаги image/tailImage в слоты first_image/tail_image', () => {
    mkdirSync(join(work, 'source'), { recursive: true });
    writeFileSync(join(work, 'source/frame.png'), 'кадр');
    const capabilities = caps('video', 'image_to_video', {}, { first_image: { required: true }, tail_image: {} });
    const selected = selectPaidRequest(
      kling,
      {
        ...base,
        project: work,
        kind: 'video',
        command: 'image_to_video',
        inputs: [
          { flag: 'image', path: 'source/frame.png' },
          { flag: 'tailImage', path: 'source/frame.png' }
        ]
      },
      capabilities
    );
    expect(selected.inputs.map((item) => item.slot)).toEqual(['first_image', 'tail_image']);
  });

  it('готовит одну опору через image_to_image со слотами image_N и выключенным story_mode', () => {
    const png = Buffer.alloc(28);
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]).copy(png);
    png.writeUInt32BE(1, 16);
    png.writeUInt32BE(1, 20);
    mkdirSync(join(work, 'source'), { recursive: true });
    writeFileSync(join(work, 'source/first.png'), png);
    const capabilities = caps('image', 'image_to_image', { img_resolution: {}, aspect_ratio: {}, story_mode: {} }, { image_1: { required: true } });
    const request = frameImageRequest(
      kling,
      {
        project: work,
        packageDir: join(work, 'pkg'),
        shot: 'M01',
        frames: [{ id: 'K01', role: 'first', timeSeconds: 0, prompt: 'Кадр', referencePaths: ['source/first.png'] }]
      },
      { provider: kling.id },
      capabilities
    );
    expect(request.command).toBe('image_to_image');
    expect(request.inputs.map((item) => item.slot)).toEqual(['image_1']);
    expect(request.parameters).toEqual({ img_resolution: '2k', aspect_ratio: '16:9', story_mode: false });
    expect(kling.rules.draftVideoCommands).toEqual(['image_to_video']);
  });
});
