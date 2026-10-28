/**
 * Тестовый провайдер медиа `test` для проверок общей логики без конкретного сервиса и сети.
 * Используется только тестами; в приложение не входит.
 */
import { createHash } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, extname, join, resolve } from 'node:path';
import { registerMediaProviderForTests } from '@shared/media-providers';
import { TEST_AGENT_PROVIDER, TEST_PROVIDER, testAgentProviderInfo, testProviderInfo } from '@shared/testing/media-provider';
import type { ToolResult } from '@shared/types';
import { registerMediaAdapterForTests } from '../providers';
import type { AgentProviderAdapter, PaidProviderAdapter } from '../providers/types';

export { TEST_AGENT_PROVIDER, TEST_PROVIDER, testAgentProviderInfo, testProviderInfo };
/** Python-адаптер тестового провайдера подключается к таблице media_adapters этой переменной. */
export const TEST_MEDIA_ADAPTERS = `${TEST_PROVIDER}=tools.testing.fake_media_request`;

export const testPaidAdapter: PaidProviderAdapter = {
  type: 'paid',
  id: TEST_PROVIDER,
  rules: {
    aliases: { image: { resolution: ['resolution', 'img_resolution', 'imgResolution'], aspect_ratio: ['aspect_ratio', 'aspectRatio'] } },
    outputCount: ['image_count', 'imageCount'],
    inputFlags: {
      image: /^(?:first_image|image(?:_\d+)?|keyframe_\d+)$/,
      tailImage: /^tail_image(?:_\d+)?$/,
      audio: /^audio(?:_\d+)?$/,
      video: /^video(?:_\d+)?$/
    },
    enforced: {
      watermark: { value: false, rejected: [true, 'true'], message: 'Снимите устаревшую настройку watermark=true: оригиналы запрашиваются без логотипа.' }
    },
    image: {
      command: (references) => (references ? 'image_to_image' : 'text_to_image'),
      referenceSlot: (index) => `image_${index + 1}`,
      series: { names: ['story_mode', 'storyMode'], off: false }
    },
    draftVideoCommands: ['image_to_video']
  },
  installed: () => true,
  environment: () => ({ checks: [], run: async () => undefined }),
  checkAuth: async () => ({ status: 'authenticated' }),
  login: async () => ({ ok: true, message: 'Вход в тестовый сервис выполнен.' }),
  smokeChecks: () => []
};

/**
 * Регистрирует провайдера `test` в реестре и таблице адаптеров, а Python-адаптер — переменной SONGFRAME_MEDIA_ADAPTERS.
 * Возвращает откат всех трёх изменений.
 */
export function registerTestMediaProvider(adapter: PaidProviderAdapter = testPaidAdapter): () => void {
  const previous = process.env.SONGFRAME_MEDIA_ADAPTERS;
  const restoreInfo = registerMediaProviderForTests(TEST_PROVIDER, testProviderInfo);
  const restoreAdapter = registerMediaAdapterForTests(adapter);
  process.env.SONGFRAME_MEDIA_ADAPTERS = TEST_MEDIA_ADAPTERS;
  return () => {
    restoreAdapter();
    restoreInfo();
    if (previous === undefined) delete process.env.SONGFRAME_MEDIA_ADAPTERS;
    else process.env.SONGFRAME_MEDIA_ADAPTERS = previous;
  };
}

/** Регистрирует провайдера-агента `test-agent` в реестре и, если передан, его адаптер; возвращает откат. */
export function registerTestAgentProvider(adapter?: Omit<AgentProviderAdapter, 'type' | 'id'>): () => void {
  const restoreInfo = registerMediaProviderForTests(TEST_AGENT_PROVIDER, testAgentProviderInfo);
  const restoreAdapter = adapter ? registerMediaAdapterForTests({ ...adapter, type: 'agent', id: TEST_AGENT_PROVIDER }) : () => undefined;
  return () => {
    restoreAdapter();
    restoreInfo();
  };
}

const sha = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');

/**
 * Офлайн-замена `media_request prepare --request spec --work-dir D`: замораживает промпт и входы
 * в формате request.json/attempt.json, не обращаясь к Python.
 */
export function prepareOffline(args: string[]): ToolResult {
  const command = `media_request ${args.join(' ')}`;
  const request = args[args.indexOf('--request') + 1];
  const directory = resolve(args[args.indexOf('--work-dir') + 1]);
  if (args[0] !== 'prepare' || !request || existsSync(directory))
    return { code: 1, stdout: '', stderr: 'Нужна новая папка попытки; существующая не перезаписывается.', command };
  const spec = JSON.parse(readFileSync(request, 'utf8')) as Record<string, unknown> & { inputs?: { path: string }[]; prompt_file: string };
  mkdirSync(join(directory, 'inputs'), { recursive: true });
  const prompt = readFileSync(resolve(dirname(request), spec.prompt_file));
  writeFileSync(join(directory, 'prompt.txt'), prompt);
  const inputs = (spec.inputs ?? []).map((item, index) => {
    const source = resolve(dirname(request), item.path);
    const path = `inputs/${String(index + 1).padStart(2, '0')}${extname(source).toLowerCase()}`;
    copyFileSync(source, join(directory, path));
    const data = readFileSync(source);
    return { ...item, path, sha256: sha(data), bytes: data.length };
  });
  const frozen = { ...spec, inputs, prompt: { path: 'prompt.txt', sha256: sha(prompt) } };
  delete (frozen as Record<string, unknown>).prompt_file;
  const body = `${JSON.stringify(frozen, null, 2)}\n`;
  const digest = sha(body);
  writeFileSync(join(directory, 'request.json'), body);
  writeFileSync(join(directory, 'attempt.json'), JSON.stringify({ schema_version: 1, request_sha256: digest, status: 'prepared', downloads: [] }));
  return { code: 0, stdout: JSON.stringify({ ...frozen, request_sha256: digest, work_dir: directory }), stderr: '', command };
}
