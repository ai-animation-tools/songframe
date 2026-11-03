import { afterEach, describe, expect, it, vi } from 'vitest';
import { ApiError, createApi, methodAvailability, withDeadline } from './api';
import type { AppState } from '@shared/types';

const state: AppState = { packaged: true, problems: [], toolsRoot: null, localDir: '/isolated/profile', current: null, history: [], platform: 'linux' };

/** Проверяет наблюдаемые гарантии границы: никаких удачных заглушек, скрытых записей и зависающих ожиданий. */
describe('Граница оболочки', () => {
  afterEach(() => vi.useRealTimers());
  it('возвращает настоящий снимок транспорта без подмены текущего проекта', async () => {
    const transport = { state: vi.fn(async () => state), frontendReady: vi.fn(async () => undefined) };
    const api = createApi(transport);
    expect(await api.app.state()).toBe(state);
    expect(transport.state).toHaveBeenCalledOnce();
  });
  it('отвергает неподдержанное платное действие до вызова транспорта', async () => {
    const transport = { state: vi.fn(async () => state), frontendReady: vi.fn(async () => undefined) };
    const api = createApi(transport);
    await expect(api.production.submit('/project', 'package', 'sha')).rejects.toMatchObject({ code: 'UNAVAILABLE', method: 'production.submit' });
    expect(transport.state).not.toHaveBeenCalled();
    expect(methodAvailability('production.submit')).toMatchObject({ available: false });
  });
  it('синхронные операции и подписки не превращаются в Promise или фиктивную отписку', () => {
    const api = createApi({ state: async () => state, frontendReady: async () => undefined });
    expect(() => api.shell.fileUrl('/file')).toThrow(ApiError);
    expect(() => api.notifications.onOpen(() => undefined)).toThrow(ApiError);
  });
  it('ошибка чтения сохраняется, повтор может завершиться успешно', async () => {
    const read = vi.fn<() => Promise<AppState>>().mockRejectedValueOnce(new Error('нет доступа')).mockResolvedValueOnce(state);
    const api = createApi({ state: read, frontendReady: async () => undefined });
    await expect(api.app.state()).rejects.toThrow('нет доступа');
    await expect(api.app.state()).resolves.toEqual(state);
  });
  it('ограничивает ожидание потерянного ответа и снимает таймер после успеха', async () => {
    vi.useFakeTimers();
    const pending = withDeadline(() => new Promise<never>(() => undefined), 'app.state', 20);
    const assertion = expect(pending).rejects.toMatchObject({ code: 'TIMEOUT' });
    await vi.advanceTimersByTimeAsync(20);
    await assertion;
    expect(vi.getTimerCount()).toBe(0);
    await expect(withDeadline(async () => state, 'app.state', 20)).resolves.toEqual(state);
    expect(vi.getTimerCount()).toBe(0);
  });
});
