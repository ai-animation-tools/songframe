/**
 * Адаптер группы updates: четыре метода идут в UpdatesService, вид Go (без путей к файлам)
 * передаётся как UpdateView контракта. Проверка и скачивание не ограничены сроком оболочки:
 * у Go свои сроки, скачивание пакета длится минуты.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { UpdateView } from '@shared/updates';
import { createApi, methodAvailability, type Bindings } from './api';

const available: UpdateView = {
  status: 'available',
  currentVersion: '1.0.0',
  version: '1.1.0',
  releaseUrl: 'https://github.com/ai-animation-tools/songframe/releases/tag/v1.1.0',
  installable: true,
  message: 'Доступна версия 1.1.0.'
};

function harness(updates: Record<string, unknown>) {
  return createApi({ updates: async () => updates as never } as unknown as Bindings);
}

describe('updates поверх UpdatesService', () => {
  afterEach(() => vi.useRealTimers());

  it('все методы перенесены', () => {
    for (const method of ['view', 'check', 'download', 'install'] as const)
      expect(methodAvailability(`updates.${method}`)).toEqual({ available: true, reason: null });
  });

  it('возвращает вид Go без изменений', async () => {
    const View = vi.fn(async () => ({ status: 'idle', currentVersion: '1.0.0' }));
    const Check = vi.fn(async () => available);
    const Install = vi.fn(async () => ({ ...available, status: 'ready' }));
    const api = harness({ View, Check, Install });
    await expect(api.updates.view()).resolves.toStrictEqual({ status: 'idle', currentVersion: '1.0.0' });
    await expect(api.updates.check()).resolves.toStrictEqual(available);
    await expect(api.updates.install()).resolves.toMatchObject({ status: 'ready' });
    expect(Check).toHaveBeenCalledWith();
  });

  it('скачивание дольше срока оболочки не прерывается', async () => {
    vi.useFakeTimers();
    let finish: (view: UpdateView) => void = () => {};
    const Download = vi.fn(() => new Promise<UpdateView>((resolve) => (finish = resolve)));
    const api = harness({ Download });
    const pending = api.updates.download();
    await vi.advanceTimersByTimeAsync(5 * 60_000);
    finish({ ...available, status: 'ready', message: 'Версия 1.1.0 скачана и проверена.' });
    await expect(pending).resolves.toMatchObject({ status: 'ready' });
  });
});
