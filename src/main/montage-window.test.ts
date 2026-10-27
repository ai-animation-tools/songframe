import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';

const state = vi.hoisted(() => ({
  handles: new Map<string, (...args: never[]) => unknown>(),
  events: new Map<string, (...args: never[]) => unknown>(),
  windows: [] as FakeWindow[],
  resolveLoad: undefined as (() => void) | undefined,
  rejectLoad: undefined as ((error: Error) => void) | undefined
}));

class FakeWindow extends EventEmitter {
  destroyed = false;
  webContents = Object.assign(new EventEmitter(), { send: vi.fn() });
  constructor() {
    super();
    state.windows.push(this);
  }
  isDestroyed(): boolean {
    return this.destroyed;
  }
  close(): void {
    this.emit('close');
    this.destroyed = true;
    this.emit('closed');
  }
  show(): void {}
  getNormalBounds() {
    return { x: 100, y: 100, width: 800, height: 500 };
  }
  loadFile(): Promise<void> {
    return new Promise((resolve, reject) => {
      state.resolveLoad = resolve;
      state.rejectLoad = reject;
    });
  }
  loadURL(): Promise<void> {
    return this.loadFile();
  }
  static fromWebContents(sender: unknown): FakeWindow | undefined {
    return state.windows.find((window) => window.webContents === sender);
  }
}

vi.doMock('electron', () => ({
  BrowserWindow: FakeWindow,
  screen: { getAllDisplays: () => [{ workArea: { x: 0, y: 0, width: 1920, height: 1080 } }] },
  ipcMain: {
    handle: (channel: string, handler: (...args: never[]) => unknown) => state.handles.set(channel, handler),
    on: (channel: string, handler: (...args: never[]) => unknown) => state.events.set(channel, handler)
  }
}));

describe('Отдельное окно плеера', () => {
  beforeEach(async () => {
    state.handles.clear();
    state.events.clear();
    state.windows.length = 0;
    state.resolveLoad = undefined;
    state.rejectLoad = undefined;
    const { registerMontageWindow } = await import('./montage-window');
    registerMontageWindow('/tmp/songframe-montage-window-test');
  });
  it('закрывает ещё загружающееся окно и изолирует сообщения его сессии', async () => {
    const owner = new FakeWindow();
    const open = state.handles.get('montage-window:open') as unknown as (event: unknown, session: string) => Promise<void>;
    const close = state.handles.get('montage-window:close') as unknown as (event: unknown, session: string) => void;
    const send = state.events.get('montage-window:message') as unknown as (event: unknown, message: unknown) => void;
    const pending = open({ sender: owner.webContents }, 'first');
    const child = state.windows[1];
    send({ sender: child.webContents }, { type: 'ready' });
    expect(owner.webContents.send).toHaveBeenCalledWith('montage-window:message', { session: 'first', message: { type: 'ready' } });
    close({ sender: owner.webContents }, 'first');
    expect(child.destroyed).toBe(true);
    expect(owner.webContents.send).toHaveBeenCalledWith('montage-window:closed', 'first');
    state.resolveLoad?.();
    await pending;
    const next = open({ sender: owner.webContents }, 'second');
    close({ sender: owner.webContents }, 'first');
    expect(state.windows[2].destroyed).toBe(false);
    state.resolveLoad?.();
    await next;
  });
  it('закрывает окно при ошибке загрузки и не пересылает события посторонних окон', async () => {
    const owner = new FakeWindow();
    const open = state.handles.get('montage-window:open') as unknown as (event: unknown, session: string) => Promise<void>;
    const send = state.events.get('montage-window:message') as unknown as (event: unknown, message: unknown) => void;
    const pending = open({ sender: owner.webContents }, 'broken');
    const child = state.windows[1];
    const other = new FakeWindow();
    send({ sender: other.webContents }, { type: 'ready' });
    expect(owner.webContents.send).not.toHaveBeenCalled();
    expect(child.webContents.send).not.toHaveBeenCalled();
    state.rejectLoad?.(new Error('Ошибка загрузки'));
    await expect(pending).rejects.toThrow('Ошибка загрузки');
    expect(child.destroyed).toBe(true);
    expect(owner.webContents.send).toHaveBeenCalledWith('montage-window:closed', 'broken');
  });
  it('закрывает плеер вместе с родительским окном', async () => {
    const owner = new FakeWindow();
    const open = state.handles.get('montage-window:open') as unknown as (event: unknown, session: string) => Promise<void>;
    const pending = open({ sender: owner.webContents }, 'owner');
    const child = state.windows[1];
    owner.close();
    expect(child.destroyed).toBe(true);
    state.resolveLoad?.();
    await pending;
  });
});
