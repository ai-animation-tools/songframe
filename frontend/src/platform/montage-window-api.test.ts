/**
 * Адаптер группы montageWindow: open/close/send идут в MontageWindowService, события
 * montage-window:message/closed — в подписки контракта. Проверяются порядок отправки
 * (вызовы Wails параллельны, ipcRenderer.send оригинала — нет), синхронный send без
 * исключений и доставка сообщений окну плеера только после базового адреса файлов.
 * Bindings подменяются целиком: Wails runtime и Go не запускаются.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { MontageWindowEvent, MontageWindowMessage } from '@shared/montage-window';
import { createApi, methodAvailability, type Bindings } from './api';

type Listener = (event: { data: unknown }) => void;

/** Bindings с одним сервисом окна плеера, базовым адресом файлов и шиной событий по именам. */
function harness(montage: Record<string, unknown>, fileBase: () => Promise<string> = async () => 'http://127.0.0.1:4100') {
  const listeners = new Map<string, Set<Listener>>();
  const missing = async () => {
    throw new Error('binding не настроен в тесте');
  };
  const b = {
    shell: async () => ({ FileBase: fileBase }) as never,
    montageWindow: async () => montage as never,
    app: missing,
    events: async () => ({
      on: (name: string, listener: Listener) => {
        const set = listeners.get(name) ?? new Set<Listener>();
        set.add(listener);
        listeners.set(name, set);
        return () => set.delete(listener);
      }
    })
  } as unknown as Bindings;
  const emit = (name: string, data: unknown) => listeners.get(name)?.forEach((listener) => listener({ data }));
  return { api: createApi(b), emit };
}

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));

describe('montageWindow поверх MontageWindowService', () => {
  afterEach(() => vi.restoreAllMocks());

  it('все методы окна перенесены, open/close возвращают ответ Go и его ошибку', async () => {
    for (const method of ['open', 'close', 'send', 'onMessage', 'onClosed'] as const)
      expect(methodAvailability(`montageWindow.${method}`)).toEqual({ available: true, reason: null });
    const Open = vi.fn(async () => undefined);
    const Close = vi.fn(async () => Promise.reject(Object.assign(new Error('Не удалось открыть отдельное окно плеера.'), { name: 'RuntimeError' })));
    const { api } = harness({ Open, Close });
    await expect(api.montageWindow.open('сессия')).resolves.toBeUndefined();
    expect(Open).toHaveBeenCalledWith('сессия');
    await expect(api.montageWindow.close('сессия')).rejects.toMatchObject({
      code: 'SERVICE_FAILED',
      method: 'montageWindow.close',
      message: 'Не удалось открыть отдельное окно плеера.'
    });
  });

  it('send синхронен, отправляет сообщения строго по очереди и не бросает при сбое', async () => {
    const sent: MontageWindowMessage[] = [];
    const pending: Array<() => void> = [];
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const Send = vi.fn(
      (message: MontageWindowMessage) =>
        new Promise<void>((resolve, reject) => {
          sent.push(message);
          pending.push(() => (message.type === 'ready' ? reject(new Error('окно закрыто')) : resolve()));
        })
    );
    const { api } = harness({ Send });
    expect(api.montageWindow.send({ type: 'ready' })).toBeUndefined();
    api.montageWindow.send({ type: 'frame', frame: 1 });
    api.montageWindow.send({ type: 'frame', frame: 2 });
    await tick();
    // Следующий вызов ждёт ответа предыдущего, даже если тот завершился ошибкой.
    expect(sent).toEqual([{ type: 'ready' }]);
    pending.shift()?.();
    await tick();
    expect(sent).toEqual([{ type: 'ready' }, { type: 'frame', frame: 1 }]);
    expect(error).toHaveBeenCalledOnce();
    pending.shift()?.();
    await tick();
    pending.shift()?.();
    await tick();
    expect(sent).toEqual([{ type: 'ready' }, { type: 'frame', frame: 1 }, { type: 'frame', frame: 2 }]);
    expect(error).toHaveBeenCalledOnce();
  });

  it('сообщения окна плеера приходят после базового адреса файлов, по порядку и не после отписки', async () => {
    let resolveBase: (value: string) => void = () => undefined;
    const { api, emit } = harness({}, () => new Promise<string>((resolve) => (resolveBase = resolve)));
    const received: Array<{ event: MontageWindowEvent; url: string }> = [];
    const unsubscribe = api.montageWindow.onMessage((event) => received.push({ event, url: api.shell.fileUrl('/клип/план 1.mp4') }));
    await tick();
    emit('montage-window:message', { session: 's', message: { type: 'ready' } });
    emit('montage-window:message', { session: 's', message: { type: 'frame', frame: 5 } });
    await tick();
    expect(received).toEqual([]);
    resolveBase('http://127.0.0.1:4100');
    await tick();
    expect(received).toEqual([
      { event: { session: 's', message: { type: 'ready' } }, url: 'http://127.0.0.1:4100/file/%D0%BA%D0%BB%D0%B8%D0%BF/%D0%BF%D0%BB%D0%B0%D0%BD%201.mp4' },
      {
        event: { session: 's', message: { type: 'frame', frame: 5 } },
        url: 'http://127.0.0.1:4100/file/%D0%BA%D0%BB%D0%B8%D0%BF/%D0%BF%D0%BB%D0%B0%D0%BD%201.mp4'
      }
    ]);
    emit('montage-window:message', { session: 's', message: { type: 'trackFrames', frames: 90 } });
    unsubscribe();
    await tick();
    expect(received).toHaveLength(2);
  });

  it('closed передаёт сессию и отписывается', async () => {
    const { api, emit } = harness({});
    const listener = vi.fn();
    const unsubscribe = api.montageWindow.onClosed(listener);
    await tick();
    emit('montage-window:closed', 'сессия');
    expect(listener).toHaveBeenCalledWith('сессия');
    unsubscribe();
    emit('montage-window:closed', 'сессия');
    expect(listener).toHaveBeenCalledOnce();
  });
});
