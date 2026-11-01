/** Точка входа Electron: окно, локальный протокол для файлов проекта, IPC. */

import { createReadStream, existsSync, statSync, writeFileSync } from 'node:fs';
import { extname, join } from 'node:path';
import { Readable } from 'node:stream';
import { app, BrowserWindow, Menu, protocol, shell, dialog } from 'electron';
import { LOCAL_FILE_SCHEME } from '@shared/api';
import { createServices, pathOptions, registerIpc, type Services } from './ipc';
import { resolvePaths } from './paths';
import { AppDiagnostics } from './app-diagnostics';
import { describeFailure } from './diagnostics';
import { runtimeSmoke } from './runtime-smoke';
import { linuxSmoke } from './linux-smoke';
import { AgentManager } from './agent-manager';
import { recoverScenarioApplications } from './scenario-apply';
import { recoverInterruptedProductionApplies } from './production-workflow';
import { externalEnvironment } from './external-environment';
import type { NotificationTarget } from '@shared/notifications';
import { DesktopNotifications } from './desktop-notifications';
import { TaskNotifications } from './task-notifications';
import { recoverDerivedApplications } from './derived-recovery';
import { recoverMontageApplications } from './montage-recovery';
import { registerMontageWindow } from './montage-window';
import { applicationTexts } from '@shared/texts/application';

// У SongFrame отдельное состояние: первый запуск не открывает проект прежнего приложения.
app.setName('songframe');

// Журнал сбоев и сеанс ведёт только оконный запуск: служебные проверки поставки не трогают сеанс пользователя.
let diagnostics: AppDiagnostics | null = null;
if (!process.env.SONGFRAME_LINUX_SMOKE && !process.env.SONGFRAME_RUNTIME_SMOKE) {
  try {
    diagnostics = new AppDiagnostics(resolvePaths(pathOptions()).localDir);
  } catch (error) {
    // eslint-disable-next-line no-restricted-syntax -- Журнал запуска остаётся в адаптере Electron и не показывается как текст интерфейса.
    console.error('Журнал сбоев недоступен:', error);
  }
}

const MIME: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
  '.gif': 'image/gif',
  '.mp3': 'audio/mpeg',
  '.wav': 'audio/wav',
  '.mp4': 'video/mp4',
  '.json': 'application/json',
  '.txt': 'text/plain; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8'
};

protocol.registerSchemesAsPrivileged([
  // standard и corsEnabled нужны, чтобы fetch из рендерера (origin file://) мог читать волну трека.
  { scheme: LOCAL_FILE_SCHEME, privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, bypassCSP: true } }
]);

/** local-file://local/abs/path: отдаёт файлы с диска для предпросмотра изображений, звука и видео проекта. */
function registerLocalFileProtocol(): void {
  protocol.handle(LOCAL_FILE_SCHEME, (request) => {
    const url = new URL(request.url);
    // Хост фиктивный (см. toLocalFileUrl); путь всегда абсолютный и лежит в pathname.
    let path = decodeURIComponent(url.pathname);
    if (process.platform === 'win32' && /^\/[A-Za-z]:/.test(path)) path = path.slice(1);
    if (!existsSync(path) || !statSync(path).isFile()) {
      // eslint-disable-next-line no-restricted-syntax -- Отсутствующий ресурс локального протокола записывается только в технический журнал.
      console.warn(`local-file: нет файла ${path} (${request.url})`);
      return new Response('Not found', { status: 404 });
    }
    const type = MIME[extname(path).toLowerCase()] ?? 'application/octet-stream';
    const size = statSync(path).size;
    // Рендерер открыт с file://, поэтому fetch к локальному протоколу считается кросс-доменным: разрешаем явно.
    // Временные обложки не должны оставаться в дисковом кэше приложения; файлы проекта могут меняться по прежнему пути.
    const headers: Record<string, string> = {
      'content-type': type,
      'accept-ranges': 'bytes',
      'access-control-allow-origin': '*',
      'cache-control': 'no-store'
    };
    // Диапазоны нужны аудио и видео для перемотки: без 206 медиаэлемент начинает с нуля.
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.get('range') ?? '');
    if (range && (range[1] || range[2])) {
      const start = range[1] ? Number(range[1]) : Math.max(0, size - Number(range[2]));
      const end = range[1] && range[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
      if (start >= size || start > end) return new Response(null, { status: 416, headers: { 'content-range': `bytes */${size}` } });
      headers['content-range'] = `bytes ${start}-${end}/${size}`;
      headers['content-length'] = String(end - start + 1);
      const part = Readable.toWeb(createReadStream(path, { start, end })) as unknown as ReadableStream;
      return new Response(part, { status: 206, headers });
    }
    headers['content-length'] = String(size);
    const body = Readable.toWeb(createReadStream(path)) as unknown as ReadableStream;
    return new Response(body, { headers });
  });
}

function createWindow(): void {
  const window = new BrowserWindow({
    width: 1320,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    show: false,
    autoHideMenuBar: true,
    title: 'SongFrame',
    // В поставке extraResources лежит рядом с app.asar; в dev используем ресурсы из корня приложения.
    icon: app.isPackaged ? join(process.resourcesPath, 'icon.png') : join(app.getAppPath(), 'resources', 'icon.png'),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      sandbox: true,
      // Прослушивание строки запускается кодом после клика по таблице; политика автозапуска этому не мешает.
      autoplayPolicy: 'no-user-gesture-required'
    }
  });
  window.once('ready-to-show', () => {
    // Windows не отдаёт передний план процессу, запущенному установщиком: без кратковременного
    // «поверх всех» первое окно открывается за другими окнами.
    if (process.platform === 'win32') window.setAlwaysOnTop(true);
    window.show();
    window.focus();
    if (process.platform === 'win32') window.setAlwaysOnTop(false);
  });
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('http://') || url.startsWith('https://')) void shell.openExternal(url);
    return { action: 'deny' };
  });
  window.webContents.on('before-input-event', (_event, input) => {
    if (input.key === 'F12' && input.type === 'keyDown') window.webContents.toggleDevTools();
  });
  // Отладка без рук: SONGFRAME_ROUTE задаёт стартовый маршрут, SONGFRAME_SCREENSHOT сохраняет снимок окна и закрывает приложение.
  const hash = process.env.SONGFRAME_ROUTE ?? '';
  if (process.env.ELECTRON_RENDERER_URL) {
    void window.loadURL(process.env.ELECTRON_RENDERER_URL + hash);
  } else {
    void window.loadFile(join(__dirname, '../renderer/index.html'), { hash: hash.replace(/^#/, '') });
  }
  const screenshot = process.env.SONGFRAME_SCREENSHOT;
  if (screenshot) {
    window.webContents.once('did-finish-load', () => {
      setTimeout(
        async () => {
          const image = await window.webContents.capturePage();
          writeFileSync(screenshot, image.toPNG());
          app.quit();
        },
        Number(process.env.SONGFRAME_SCREENSHOT_DELAY ?? 1500)
      );
    });
  }
}

let services: Services;

/** Уведомление возвращает существующее окно: перезагрузка renderer прервала бы его локальные формы. */
function openNotificationTarget(target: NotificationTarget): void {
  const window = BrowserWindow.getAllWindows()[0];
  if (!window || window.isDestroyed()) return;
  if (window.isMinimized()) window.restore();
  window.show();
  window.focus();
  window.webContents.send('notifications:open', target);
}

app
  .whenReady()
  .then(async () => {
    if (process.platform === 'linux' && !process.env.SONGFRAME_LINUX_SMOKE && !process.env.SONGFRAME_RUNTIME_SMOKE) {
      // Графический запуск не наследует nvm из терминала; один PATH нужен диагностике, агентам и вложенным программам провайдеров генерации.
      process.env.PATH = (await externalEnvironment()).PATH;
    }
    if (process.platform === 'linux' && process.env.SONGFRAME_LINUX_SMOKE) {
      services = createServices();
      const ok = await linuxSmoke(services.launcher, process.env.SONGFRAME_LINUX_SMOKE);
      app.exit(ok ? 0 : 1);
      return;
    }
    Menu.setApplicationMenu(null);
    registerLocalFileProtocol();
    // Как и SONGFRAME_SCREENSHOT, этот режим нужен локальной проверке сборки и не открывает пользовательский проект.
    if (process.env.SONGFRAME_RUNTIME_SMOKE) {
      try {
        services = createServices();
        const ok = await runtimeSmoke(services.launcher, process.env.SONGFRAME_RUNTIME_SMOKE);
        app.exit(ok ? 0 : 1);
      } catch (error) {
        console.error(error);
        // Ошибка проверки сохраняется туда же, где успешный результат: рядом с запускающим CMD.
        writeFileSync(
          process.env.SONGFRAME_RUNTIME_SMOKE,
          JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2) + '\n'
        );
        app.exit(1);
      }
      return;
    }
    // Windows использует тот же постоянный ID, что и сборка; ярлык и toast activator создаёт Electron.
    // Headless-режимы выше не регистрируют приложение ради уведомлений.
    if (process.platform === 'win32') app.setAppUserModelId('tools.songframe.app');
    services = createServices({ restoreJobs: true });
    if (diagnostics) services.diagnostics = diagnostics;
    const desktopNotifications = new DesktopNotifications(openNotificationTarget);
    services.notifications = new TaskNotifications((notice) => desktopNotifications.show(notice));
    // Только старт окна восстанавливает незавершённое применение; headless не мешает живому окну.
    for (const recover of [
      recoverScenarioApplications,
      recoverInterruptedProductionApplies,
      () => {
        const state = services.projects.appState();
        for (const project of new Set([state.current, ...state.history.map((item) => item.path)]))
          if (project) {
            recoverMontageApplications(project);
            recoverDerivedApplications(project);
          }
      }
    ])
      try {
        recover(services.settings.localDir);
      } catch (error) {
        // Ошибка одного восстановления не закрывает приложение; незавершённый проект не открываем автоматически.
        services.projects.close();
        const message = error instanceof Error ? error.message : String(error);
        dialog.showErrorBox(applicationTexts.projectRecoveryTitle, applicationTexts.projectRecoveryFailed({ reason: message }));
      }
    services.agents = new AgentManager(services.settings);
    registerIpc(
      () => services,
      (next) => {
        services = next;
      }
    );
    registerMontageWindow(services.settings.localDir);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  })
  .catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error);
    console.error(message);
    diagnostics?.log.write('startup', describeFailure(error));
    if (!process.env.SONGFRAME_LINUX_SMOKE) dialog.showErrorBox(applicationTexts.startupFailedTitle, message);
    app.exit(1);
  });

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Сеанс чистый, только когда Electron действительно завершает работу (после возможной отсрочки before-quit).
app.on('will-quit', () => diagnostics?.finish());

let coverCleanup: Promise<void> | null = null;
let coversClosed = false;
app.on('before-quit', (event) => {
  services?.agents?.shutdown();
  if (!services?.cover || coversClosed) return;
  // Сначала останавливаем запись генератора и удаляем временные изображения, затем завершаем Electron.
  event.preventDefault();
  coverCleanup ??= Promise.all([services.cover.shutdown(), services.referenceImages?.shutdown(), services.videoReview?.shutdown()])
    .then(() => undefined)
    // eslint-disable-next-line no-restricted-syntax -- Ошибка очистки записывается только в журнал завершения приложения.
    .catch((error: unknown) => console.error('Не удалось очистить временные обложки:', error))
    .finally(() => {
      coversClosed = true;
      app.quit();
    });
});
