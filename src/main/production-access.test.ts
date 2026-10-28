/** Проверяем общий для IPC допуск по настоящим файлам пакета; доступ к CLI подменён и ничего не отправляет. */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MediaKind } from '@shared/media-providers';
import { requireProductionPackageAccess } from './production-access';

let project: string;
let packageDir: string;

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function fixture(kind: MediaKind, frozenProvider: string, selectedProvider: string): void {
  const requestSha = 'a'.repeat(64);
  writeJson(join(project, 'plan/project.json'), {
    name: 'Проверка допуска',
    generation: {
      image: { provider: kind === 'image' ? selectedProvider : 'другой провайдер изображений', provider_selected: true },
      video: { provider: kind === 'video' ? selectedProvider : 'другой провайдер видео', provider_selected: true }
    }
  });
  writeJson(join(packageDir, 'workflow.json'), {
    shot: 'M45',
    executor: 'app',
    stage: kind === 'image' ? 'image_request_choice' : 'request_choice',
    ...(kind === 'image'
      ? {
          image_request_dir: 'request',
          image_frame_id: 'first',
          image_requests: [{ request_dir: 'request', frame_id: 'first', request_sha256: requestSha, provider: frozenProvider }]
        }
      : { request_dir: 'request' })
  });
  writeJson(join(packageDir, 'request/request.json'), {
    kind,
    provider: frozenProvider,
    model: 'test-model',
    command: kind === 'image' ? 'text_to_image' : 'image_to_video',
    parameters: {},
    inputs: []
  });
  writeJson(join(packageDir, 'request/attempt.json'), { status: 'prepared', request_sha256: requestSha, downloads: [] });
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-production-access-'));
  packageDir = join(project, 'plan/batches/M45-attempt-01');
});

afterEach(() => {
  rmSync(project, { recursive: true, force: true });
});

describe.each(['image', 'video'] as const)('допуск пакета %s', (kind) => {
  it.each([
    ['Kling', 'kling'],
    [' \tKlInG\n', '\n kLiNg \t']
  ])('разрешает сохранённый %j при выбранном %j и проверяет доступ нужного медиа', async (frozenProvider, selectedProvider) => {
    fixture(kind, frozenProvider, selectedProvider);
    const requireAccess = vi.fn(async (_project: string, _kind: MediaKind): Promise<void> => {});

    await expect(requireProductionPackageAccess(project, packageDir, requireAccess)).resolves.toBeUndefined();

    expect(requireAccess).toHaveBeenCalledExactlyOnceWith(project, kind);
  });

  it('блокирует запрос после выбора действительно другого провайдера', async () => {
    fixture(kind, 'Kling', 'Другой сервис');
    const requireAccess = vi.fn(async (_project: string, _kind: MediaKind): Promise<void> => {});

    await expect(requireProductionPackageAccess(project, packageDir, requireAccess)).rejects.toThrow('Провайдер медиа изменился');
  });

  it('сохраняет отказ проверки доступа при совпадающем провайдере', async () => {
    fixture(kind, 'Kling', 'kling');
    const accessError = new Error('Выбранный агент недоступен');
    const requireAccess = vi.fn(async (_project: string, _kind: MediaKind): Promise<void> => {
      throw accessError;
    });

    await expect(requireProductionPackageAccess(project, packageDir, requireAccess)).rejects.toBe(accessError);

    expect(requireAccess).toHaveBeenCalledExactlyOnceWith(project, kind);
  });
});

it('не проверяет CLI для пакета без подготовленного запроса', async () => {
  fixture('video', 'Kling', 'kling');
  writeJson(join(packageDir, 'workflow.json'), { shot: 'M45', executor: 'app', stage: 'prompt_review' });
  const requireAccess = vi.fn(async (_project: string, _kind: MediaKind): Promise<void> => {});

  await expect(requireProductionPackageAccess(project, packageDir, requireAccess)).rejects.toThrow('В пакете нет сохранённого запроса');

  expect(requireAccess).not.toHaveBeenCalled();
});

it('не проверяет CLI для запроса без сохранённого провайдера', async () => {
  fixture('video', 'Kling', 'kling');
  writeJson(join(packageDir, 'request/request.json'), { kind: 'video', model: 'test-model', parameters: {}, inputs: [] });
  const requireAccess = vi.fn(async (_project: string, _kind: MediaKind): Promise<void> => {});

  await expect(requireProductionPackageAccess(project, packageDir, requireAccess)).rejects.toThrow('В сохранённом запросе не указан провайдер');

  expect(requireAccess).not.toHaveBeenCalled();
});
