import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { installApi } from './api';

const binding = vi.hoisted(() => ({ State: vi.fn(), FrontendReady: vi.fn() }));
vi.mock('../../bindings/songframe-go/internal/app/shellservice', () => binding);
const valid = { packaged: true, problems: [], toolsRoot: null, localDir: '/isolated/profile', current: null, history: [], platform: 'linux' };

/** Проверяется настоящий mapping адаптера после generated binding, отдельно от подмены ShellTransport. */
describe('Ответы нативной границы', () => {
  beforeEach(() => {
    vi.stubGlobal('window', {});
    binding.State.mockReset();
    installApi();
  });
  afterEach(() => vi.unstubAllGlobals());
  it('принимает Go DTO с явными null и пустыми массивами', async () => {
    binding.State.mockResolvedValue(valid);
    await expect(window.api.app.state()).resolves.toEqual(valid);
  });
  it('сохраняет причину ошибки Go-сервиса вместо сообщения о разрыве связи', async () => {
    const error = new Error('Не удалось подготовить папку состояния: путь занят файлом.');
    error.name = 'RuntimeError';
    binding.State.mockRejectedValue(error);
    await expect(window.api.app.state()).rejects.toMatchObject({ code: 'SERVICE_FAILED', message: error.message });
  });
  it('отдельно сообщает об ошибке транспорта', async () => {
    binding.State.mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(window.api.app.state()).rejects.toMatchObject({ code: 'CONNECTION_FAILED' });
  });
  it.each([null, undefined, { ...valid, problems: null }, { ...valid, history: [null] }, { ...valid, history: [{}] }, { ...valid, platform: 'other' }])(
    'отклоняет некорректный DTO без падения renderer: %j',
    async (response) => {
      binding.State.mockResolvedValue(response);
      await expect(window.api.app.state()).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    }
  );
});
