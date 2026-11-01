/** Платный lifecycle обложки проверяется на подставном провайдере без сети и расхода кредитов. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi, type Mock } from 'vitest';
import type { MediaCapabilities } from '@shared/media-providers';
import type { ToolResult } from '@shared/types';
import { preparePaidCover, type PaidCoverOptions } from './cover-paid';
import type { PreparePaidInput, PreparedMediaRequest } from './media-providers';
import { registerTestMediaProvider, TEST_PROVIDER, testPaidAdapter, testProviderInfo } from './testing/media-provider';
import type { PythonLauncher } from './python-launcher';

let root: string;
let project: string;
let workDir: string;
let caps: MediaCapabilities;
let selected: PreparePaidInput;
let options: PaidCoverOptions;
let restoreProvider: () => void;
beforeAll(() => {
  restoreProvider = registerTestMediaProvider();
});
afterAll(() => restoreProvider());
let run: Mock<PythonLauncher['run']>;
let controller: AbortController;
const sha = 'a'.repeat(64);
function settings(image: Record<string, unknown> = {}): void {
  writeFileSync(join(project, 'plan/project.json'), JSON.stringify({ generation: { image: { provider: TEST_PROVIDER, ...image } } }));
}
const result = (stdout = '', code = 0): ToolResult => ({ code, stdout, stderr: '', command: '' });
const priceResult = (credits: number | null = 10, balance: number | null = 100, verdict = 'ok', code = 0): ToolResult =>
  result(JSON.stringify({ estimate_credits: credits, balance_credits: balance, verdict }), code);
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'songframe-cover-paid-test-'));
  project = join(root, 'project');
  workDir = join(root, 'session');
  mkdirSync(join(project, 'plan'), { recursive: true });
  mkdirSync(workDir);
  settings();
  controller = new AbortController();
  caps = {
    provider: TEST_PROVIDER,
    kind: 'image',
    available: true,
    checkedAt: '',
    generationVerified: false,
    problems: [],
    models: [
      {
        id: 'account-model',
        command: 'text_to_image',
        arguments: {
          imgResolution: { allowed: ['1k', '2k'] },
          aspectRatio: { allowed: ['1:1', '16:9'] },
          imageCount: {},
          story_mode: {},
          quality: { allowed: ['high'] }
        },
        slots: {},
        limits: {}
      }
    ]
  };
  run = vi.fn<PythonLauncher['run']>(async (_project, name: string) => (name === 'cost_check' ? priceResult() : result()));
  options = {
    pricingArgs: () => ['--pricing', '/tmp/test-pricing.json'],
    launcher: () => ({ run }),
    provider: {
      adapter: testPaidAdapter,
      capabilities: vi.fn(async () => caps),
      prepare: vi.fn<PaidCoverOptions['provider']['prepare']>(async (input) => {
        selected = input;
        return { provider: TEST_PROVIDER, kind: 'image', project, requestDir: input.workDir, requestSha: sha };
      }),
      submit: vi.fn<PaidCoverOptions['provider']['submit']>(async (request, execute) => {
        await execute('submit', request);
        return { provider: TEST_PROVIDER, kind: 'image', requestDir: request.requestDir, requestSha: request.requestSha };
      }),
      collect: vi.fn<PaidCoverOptions['provider']['collect']>(() => [{ path: join(workDir, 'request/original.png'), index: 1, kind: 'image', sha256: sha }])
    }
  };
});
afterEach(() => rmSync(root, { recursive: true, force: true }));
const prepare = () => preparePaidCover({ workDir, project, prompt: '  Обложка\nточно по тексту.  ', signal: controller.signal }, options);

it('готовит отдельную квадратную обложку с объявленной моделью и точным промптом, не отправляя её', async () => {
  settings({
    model: 'unavailable-model',
    resolution: '1k',
    aspect_ratio: '16:9',
    outputs: 9,
    options: { aspectRatio: '16:9', quality: 'high', imageCount: 9 }
  });
  const candidate = await prepare();
  expect(candidate).toMatchObject({ provider: TEST_PROVIDER, model: 'account-model', requestSha: sha, quote: { credits: 10, balance: 100, verdict: 'ok' } });
  expect(selected).toMatchObject({
    project,
    workDir: join(workDir, 'request'),
    shot: 'M00',
    command: 'text_to_image',
    outputs: 1,
    inputs: [],
    prompt: '  Обложка\nточно по тексту.  '
  });
  expect(selected.parameters).toEqual({ imgResolution: '1k', aspectRatio: '1:1', imageCount: 1, story_mode: false, quality: 'high' });
  expect(options.provider.submit).not.toHaveBeenCalled();
  expect(run).toHaveBeenCalledExactlyOnceWith(
    project,
    'cost_check',
    ['check', '--work-dir', join(workDir, 'request'), '--json', '--pricing', '/tmp/test-pricing.json'],
    { signal: controller.signal }
  );
});

it('проверяет цену ещё раз, отправляет один раз с тем же SHA и ждёт тот же запрос', async () => {
  const candidate = await prepare();
  const generated = await candidate.generate(controller.signal);
  expect(generated.path).toBe(join(workDir, 'request/original.png'));
  expect(run.mock.calls.map((call) => [call[1], call[2][0]])).toEqual([
    ['cost_check', 'check'],
    ['cost_check', 'check'],
    ['media_request', 'submit'],
    ['media_request', 'watch'],
    // Фактическое списание запоминается: такой же запрос в следующий раз покажет цену.
    ['cost_check', 'learn']
  ]);
  expect(run.mock.calls[2][2]).toEqual(['submit', '--work-dir', join(workDir, 'request'), '--confirm', sha]);
  expect(run.mock.calls[3][2]).toEqual(['watch', '--work-dir', join(workDir, 'request'), '--max-minutes', '15']);
  await expect(candidate.generate(controller.signal)).rejects.toThrow('уже запускалась');
  expect(options.provider.submit).toHaveBeenCalledTimes(1);
});

it.each([
  [11, 100, 'ok', 0],
  [10, 99, 'ok', 0],
  [10, 1, 'insufficient_balance', 2],
  [10, 100, 'cost_or_balance_unknown', 2]
])('не отправляет при изменении цены/баланса или неизвестном тарифе: %s, %s, %s', async (credits, balance, verdict, code) => {
  const candidate = await prepare();
  run.mockResolvedValue(priceResult(credits, balance, verdict, code));
  await expect(candidate.generate(controller.signal)).rejects.toThrow(
    'Стоимость или остаток изменились. Подготовьте запрос и подтвердите цену заново; отправка не выполнялась.'
  );
  expect(options.provider.submit).not.toHaveBeenCalled();
});

it('не отправляет при неизвестной первоначальной цене', async () => {
  run.mockResolvedValue(priceResult(10, 100, 'cost_or_balance_unknown', 2));
  const candidate = await prepare();
  await expect(candidate.generate(controller.signal)).rejects.toThrow('подтвердите цену');
  expect(options.provider.submit).not.toHaveBeenCalled();
});

it('оставляет повреждённую проверку цены для явного согласия и отвергает неподдерживаемые параметры', async () => {
  run.mockResolvedValue(result('null'));
  expect((await prepare()).quote).toMatchObject({
    credits: null,
    balance: null,
    verdict: 'cost_or_balance_unknown',
    message: 'Не удалось получить стоимость и остаток кредитов Тестовый сервис.'
  });
  settings({ options: { quality: 'unknown' } });
  await expect(prepare()).rejects.toThrow('Нет совместимой модели');
});

it('не добавляет неявный resolution без объявления и не меняет явное значение ради модели', async () => {
  delete caps.models[0].arguments.imgResolution;
  await prepare();
  expect(selected.parameters).not.toHaveProperty('resolution');
  settings({ resolution: '1k' });
  await expect(prepare()).rejects.toThrow('Нет совместимой модели');
});

it('раскрывает совпадающие aliases разрешения и отклоняет конфликт явных значений', async () => {
  settings({ resolution: '1k', options: { img_resolution: '1k' } });
  await prepare();
  expect(selected.parameters.imgResolution).toBe('1k');
  settings({ resolution: '1k', options: { imgResolution: '2k' } });
  await expect(prepare()).rejects.toThrow('конфликтует');
});

it('выбирает модель по явному quality и требует объявленный квадратный формат', async () => {
  caps.models.unshift({ ...caps.models[0], id: 'preferred', arguments: { ...caps.models[0].arguments, quality: { allowed: ['low'] } } });
  settings({ model: 'preferred', options: { quality: 'high' } });
  await prepare();
  expect(selected.model).toBe('account-model');
  for (const model of caps.models) delete model.arguments.aspectRatio;
  await expect(prepare()).rejects.toThrow('Нет совместимой модели');
});

it('не отправляет отменённую попытку и передаёт отмену в проверку цены', async () => {
  const candidate = await prepare();
  run.mockImplementation(async (_project, name: string, _args: string[], launch) => {
    expect(name).toBe('cost_check');
    expect(launch?.signal).toBe(controller.signal);
    controller.abort();
    return priceResult();
  });
  await expect(candidate.generate(controller.signal)).rejects.toThrow('остановлена');
  expect(options.provider.submit).not.toHaveBeenCalled();
});

it('при отмене ожидания не повторяет submit и не обещает возврат кредитов', async () => {
  const candidate = await prepare();
  run.mockImplementation(async (_project, name: string, args: string[], launch) => {
    if (name === 'cost_check') return priceResult();
    expect(launch?.signal).toBe(controller.signal);
    if (args[0] === 'watch') controller.abort();
    return result();
  });
  await expect(candidate.generate(controller.signal)).rejects.toThrow(
    'Получение обложки остановлено. Запрос мог быть отправлен в Тестовый сервис; отмена ожидания не возвращает кредиты.'
  );
  expect(options.provider.collect).not.toHaveBeenCalled();
  expect(options.provider.submit).toHaveBeenCalledTimes(1);
});

it('не принимает несколько результатов и не повторяет неуспешную отправку', async () => {
  const candidate = await prepare();
  vi.mocked(options.provider.collect).mockReturnValue([]);
  await expect(candidate.generate(controller.signal)).rejects.toThrow('ровно одно');
  const next = await prepare();
  run.mockImplementation(async (_project, name: string) => (name === 'cost_check' ? priceResult() : result('', 2)));
  await expect(next.generate(controller.signal)).rejects.toThrow('Не удалось отправить');
  await expect(next.generate(controller.signal)).rejects.toThrow('уже запускалась');
});

it('не подготавливает платную обложку при другом провайдере или заранее отменённой операции', async () => {
  settings({ provider: 'codex' });
  await expect(prepare()).rejects.toThrow(`Выберите ${testProviderInfo.title}`);
  expect(options.provider.capabilities).not.toHaveBeenCalled();
  controller.abort();
  await expect(prepare()).rejects.toThrow('остановлена');
});

it('передаёт неизменяемую ссылку подготовленной попытки провайдеру', async () => {
  const candidate = await prepare();
  await candidate.generate(controller.signal);
  const reference: PreparedMediaRequest = { provider: TEST_PROVIDER, kind: 'image', project, requestDir: join(workDir, 'request'), requestSha: sha };
  expect(options.provider.submit).toHaveBeenCalledWith(reference, expect.any(Function));
  expect(options.provider.collect).toHaveBeenCalledWith(reference);
});

it.each([result('null'), result('это не JSON'), result('{}', 1), priceResult(10, 1, 'ok')])(
  'ошибка ответа цены не скрывает возможность явного согласия: %j',
  async (response) => {
    run.mockResolvedValue(response);
    const candidate = await prepare();
    expect(candidate.quote).toMatchObject({ credits: null, balance: null, verdict: 'cost_or_balance_unknown' });
    await expect(candidate.generate(controller.signal)).rejects.toThrow('согласие на неизвестную стоимость');
    expect(options.provider.submit).not.toHaveBeenCalled();
  }
);

it('ошибка запуска проверки цены становится неизвестной ценой, но отмена остаётся отменой', async () => {
  run.mockRejectedValue(new Error('Сервис недоступен'));
  expect((await prepare()).quote).toMatchObject({ credits: null, balance: null, verdict: 'cost_or_balance_unknown' });
  run.mockRejectedValue(Object.assign(new Error('Отменено'), { name: 'AbortError' }));
  await expect(prepare()).rejects.toThrow('Отменено');
});

it.each([
  [null, null, 'cost_or_balance_unknown', 2, true],
  [17, 100, 'ok', 0, true],
  [17, 1, 'insufficient_balance', 2, false],
  [17, null, 'cost_or_balance_unknown', 2, false]
])('согласие на неизвестную цену проверяет свежий ответ и допускает ровно одну отправку: %s / %s / %s', async (credits, balance, verdict, code, allowed) => {
  run.mockResolvedValueOnce(priceResult(null, null, 'cost_or_balance_unknown', 2));
  const candidate = await prepare();
  run.mockImplementation(async (_project, name) => (name === 'cost_check' ? priceResult(credits, balance, verdict, code) : result()));
  if (allowed) {
    await candidate.generate(controller.signal, { allowUnknownCost: true });
    expect(options.provider.submit).toHaveBeenCalledTimes(1);
    expect(run.mock.calls.filter((call) => call[1] === 'media_request' && call[2][0] === 'submit')).toHaveLength(1);
  } else {
    await expect(candidate.generate(controller.signal, { allowUnknownCost: true })).rejects.toThrow(
      'Стоимость или остаток изменились. Подготовьте запрос и подтвердите цену заново; отправка не выполнялась.'
    );
    expect(options.provider.submit).not.toHaveBeenCalled();
  }
  await expect(candidate.generate(controller.signal, { allowUnknownCost: true })).rejects.toThrow('уже запускалась');
});

it('после сбоя обеих проверок цены отправляет только по явному согласию', async () => {
  run.mockImplementation(async (_project, name) => {
    if (name === 'cost_check') throw new Error('Сервис стоимости недоступен');
    return result();
  });
  const candidate = await prepare();
  await candidate.generate(controller.signal, { allowUnknownCost: true });
  expect(options.provider.submit).toHaveBeenCalledTimes(1);
});

it('согласие на неизвестную цену не снимает начальную нехватку средств или неизвестный баланс при известной цене', async () => {
  for (const verdict of ['insufficient_balance', 'cost_or_balance_unknown']) {
    run.mockResolvedValue(priceResult(10, 1, verdict, 2));
    const candidate = await prepare();
    await expect(candidate.generate(controller.signal, { allowUnknownCost: true })).rejects.toThrow('не подтверждены');
  }
  expect(options.provider.submit).not.toHaveBeenCalled();
});

it('передаёт опоры референса в image_to_image по объявленным слотам вместо текстового запроса', async () => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM6sAAAAASUVORK5CYII=', 'base64');
  const path = join(workDir, 'reference.png');
  writeFileSync(path, bytes);
  caps.models.push({ ...caps.models[0], command: 'image_to_image', slots: { image_1: { required: true } } });
  await preparePaidCover(
    {
      workDir,
      project,
      prompt: 'Сохрани того же персонажа и стиль клипа.',
      purpose: 'reference',
      references: [{ path, label: 'Олег: лицо', sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length }],
      signal: controller.signal
    },
    options
  );
  expect(selected.command).toBe('image_to_image');
  expect(selected.inputs).toEqual([{ flag: 'input', slot: 'image_1', role: 'Олег: лицо', path }]);
  expect(selected.prompt).toBe('Сохрани того же персонажа и стиль клипа.');
  expect(options.provider.submit).not.toHaveBeenCalled();
});

// Описания входят только в показанный пользователю текст; платный адаптер не пересобирает его по опорам.
it.each([
  ['без описаний', '  Сохрани внешность Олега.\r\nСтиль: объёмная анимация.  '],
  ['с описаниями', '  Сохрани внешность Олега.\r\n\r\nОписания выбранных опор:\r\n1. Шрам над левой бровью.\r\n2. Синяя куртка.  '],
  ['после ручной правки', '  Пользователь заменил весь промпт.\r\nТолько силуэт, без куртки.\n  ']
])('передаёт финальный промпт референса платному провайдеру дословно: %s', async (_mode, prompt) => {
  const bytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aM6sAAAAASUVORK5CYII=', 'base64');
  const references = ['Опора 1', 'Опора 2'].map((label, index) => {
    const path = join(workDir, `reference-${index + 1}.png`);
    writeFileSync(path, bytes);
    return { path, label, sha256: createHash('sha256').update(bytes).digest('hex'), bytes: bytes.length };
  });
  caps.models.push({ ...caps.models[0], command: 'image_to_image', slots: { image_1: { required: true }, image_2: {} } });
  await preparePaidCover({ workDir, project, prompt, purpose: 'reference', references, signal: controller.signal }, options);
  expect(selected.prompt).toBe(prompt);
  expect(selected.command).toBe('image_to_image');
  expect(selected.inputs).toEqual(references.map((image, index) => ({ flag: 'input', slot: `image_${index + 1}`, role: image.label, path: image.path })));
  expect(selected.parameters).toEqual({ imgResolution: '2k', aspectRatio: '1:1', imageCount: 1, story_mode: false });
  expect(options.provider.submit).not.toHaveBeenCalled();
});
