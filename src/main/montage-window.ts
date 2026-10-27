import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { BrowserWindow, ipcMain, screen } from 'electron';
import type { MontageWindowMessage } from '@shared/montage-window';
import { usableMontageBounds } from './montage-window-bounds';

/** Одно окно принадлежит одному renderer: его сообщения и закрытие не попадают в другие сессии. */
export function registerMontageWindow(localDir: string): void {
  let current: { session: string; owner: BrowserWindow; window: BrowserWindow } | null = null;
  const boundsFile = join(localDir, 'montage-window.json');
  ipcMain.handle('montage-window:open', async (event, session: string) => {
    const owner = BrowserWindow.fromWebContents(event.sender);
    if (!owner || owner.isDestroyed() || !session || current) throw new Error('Не удалось открыть отдельное окно плеера.');
    let bounds;
    try {
      bounds = usableMontageBounds(
        JSON.parse(readFileSync(boundsFile, 'utf8')),
        screen.getAllDisplays().map((display) => display.workArea)
      );
    } catch {
      // При первом запуске или недоступном файле положения окно создаётся в обычном месте.
    }
    const window = new BrowserWindow({
      width: 820,
      height: 540,
      ...bounds,
      minWidth: 480,
      minHeight: 270,
      show: false,
      autoHideMenuBar: true,
      title: 'Плеер монтажа — SongFrame',
      webPreferences: {
        preload: join(__dirname, '../preload/index.js'),
        contextIsolation: true,
        sandbox: true,
        autoplayPolicy: 'no-user-gesture-required'
      }
    });
    const entry = { session, owner, window };
    current = entry;
    const ownerClosed = (): void => {
      if (!window.isDestroyed()) window.close();
    };
    owner.once('closed', ownerClosed);
    window.once('ready-to-show', () => window.show());
    window.once('closed', () => {
      owner.removeListener('closed', ownerClosed);
      if (current === entry) current = null;
      if (!owner.isDestroyed()) owner.webContents.send('montage-window:closed', session);
    });
    window.on('close', () => {
      try {
        mkdirSync(localDir, { recursive: true });
        writeFileSync(boundsFile, JSON.stringify(window.getNormalBounds()));
      } catch {
        // Ошибка сохранения положения не препятствует закрытию плеера.
      }
    });
    window.webContents.on('render-process-gone', () => window.close());
    try {
      if (process.env.ELECTRON_RENDERER_URL) await window.loadURL(`${process.env.ELECTRON_RENDERER_URL}#/montage-player`);
      else await window.loadFile(join(__dirname, '../renderer/index.html'), { hash: '/montage-player' });
    } catch (error) {
      if (!window.isDestroyed()) window.close();
      throw error;
    }
  });
  ipcMain.handle('montage-window:close', (event, session: string) => {
    if (!current || current.session !== session || event.sender !== current.owner.webContents) return;
    current.window.close();
  });
  ipcMain.on('montage-window:message', (event, message: MontageWindowMessage) => {
    if (!current) return;
    const { owner, window, session } = current;
    const destination = event.sender === owner.webContents ? window : event.sender === window.webContents ? owner : null;
    if (destination && !destination.isDestroyed()) destination.webContents.send('montage-window:message', { session, message });
  });
}
