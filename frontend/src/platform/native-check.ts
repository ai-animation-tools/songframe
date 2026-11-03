import { Events } from '@wailsio/runtime';
import * as checkService from '../../bindings/songframe-go/internal/app/nativecheckservice';
import * as native from '../../bindings/songframe-go/internal/app/nativeservice';
import * as projects from '../../bindings/songframe-go/internal/app/projectservice';
import * as timingService from '../../bindings/songframe-go/internal/app/timingservice';

/** Результат одного независимого наблюдения WebView, без вывода о физическом звуке. */
export interface NativeObservation {
  name: string;
  passed: boolean;
  details: string;
}
interface MediaInput {
  path: string;
  url: string;
  kind: string;
}
const delay = (milliseconds: number) => new Promise<void>((resolve) => setTimeout(resolve, milliseconds));
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

/** Ограничивает binding/decode по времени; вызывающий finally освобождает принадлежащие ему ресурсы. */
async function timed<T>(operation: PromiseLike<T>, milliseconds = 7000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new Error('Истекло время нативной проверки')), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Слушатели устанавливаются до действия и снимаются при успехе, ошибке и timeout. */
function mediaEvent(element: HTMLMediaElement, name: string, action: () => void): Promise<void> {
  return new Promise((resolve, reject) => {
    const clean = () => {
      clearTimeout(timer);
      element.removeEventListener(name, ready);
      element.removeEventListener('error', failed);
    };
    const ready = () => {
      clean();
      resolve();
    };
    const failed = () => {
      clean();
      reject(new Error(`Ошибка медиа: ${element.error?.message || element.error?.code || 'неизвестная'}`));
    };
    const timer = setTimeout(() => {
      clean();
      reject(new Error(`Не получено событие ${name}`));
    }, 7000);
    element.addEventListener(name, ready);
    element.addEventListener('error', failed);
    try {
      action();
    } catch (error) {
      clean();
      reject(error);
    }
  });
}

/** Создаёт настоящий HTML-плеер в проверяемом WebView; always-finally останавливает сеть и декодер. */
async function withMedia<T>(file: MediaInput, host: HTMLElement, verify: (element: HTMLMediaElement) => Promise<T>): Promise<T> {
  const element = document.createElement(file.kind === 'video' ? 'video' : 'audio');
  element.controls = true;
  element.muted = true;
  element.volume = 0;
  element.preload = 'auto';
  if (element instanceof HTMLVideoElement) {
    element.width = 320;
    element.playsInline = true;
  }
  host.append(element);
  try {
    await mediaEvent(element, 'loadedmetadata', () => {
      element.src = file.url;
      element.load();
    });
    if (!Number.isFinite(element.duration) || element.duration <= 0) throw new Error('Не определена длительность медиа');
    return await verify(element);
  } finally {
    element.pause();
    element.removeAttribute('src');
    element.load();
    element.remove();
  }
}

/** Проверяет реальный переход позиции, а не только поддержку MIME или успешный Promise play. */
async function playback(file: MediaInput, host: HTMLElement): Promise<string> {
  return withMedia(file, host, async (element) => {
    const target = element.duration * 0.5;
    await mediaEvent(element, 'seeked', () => {
      element.currentTime = target;
    });
    if (Math.abs(element.currentTime - target) > 0.2) throw new Error('Перемотка не достигла заданной позиции');
    const before = element.currentTime;
    await timed(element.play());
    await delay(450);
    if (element.currentTime - before < 0.05) throw new Error('После play позиция не движется');
    if (element instanceof HTMLVideoElement && (!element.videoWidth || !element.videoHeight)) throw new Error('Видео не сообщило размеры кадра');
    return JSON.stringify({ duration: element.duration, seek: before, advanced: element.currentTime - before, muted: true });
  });
}

/** Цикл проверяется по переходу currentTime через конец WAV и продолжению после возврата. */
async function loop(file: MediaInput, host: HTMLElement): Promise<string> {
  return withMedia(file, host, async (element) => {
    element.loop = true;
    await mediaEvent(element, 'seeked', () => {
      element.currentTime = Math.max(0, element.duration - 0.35);
    });
    let previous = element.currentTime;
    await timed(element.play());
    const until = performance.now() + 4000;
    while (performance.now() < until) {
      await delay(30);
      const current = element.currentTime;
      if (current < previous - 0.2) {
        await delay(180);
        if (element.currentTime <= current + 0.03) throw new Error('Цикл вернулся, но воспроизведение не продолжилось');
        return JSON.stringify({ before: previous, wrapped: current, continued: element.currentTime });
      }
      previous = current;
    }
    throw new Error('Не обнаружен фактический возврат цикла');
  });
}

/** HTTP-проверка использует тот же origin WebView и CORS, что fetch волны, с отменой зависшего запроса. */
async function fetchMedia(url: string, init: RequestInit = {}): Promise<Response> {
  return fetch(url, { ...init, cache: 'no-store', signal: AbortSignal.timeout(7000) });
}

/** AudioContext должен декодировать непустой сигнал, пригодный для построения волны. */
async function decode(file: MediaInput): Promise<string> {
  const response = await fetchMedia(file.url);
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  const context = new AudioContext();
  try {
    const buffer = await timed(context.decodeAudioData(await timed(response.arrayBuffer())));
    if (!buffer.length || buffer.duration <= 0 || !buffer.numberOfChannels) throw new Error('Декодирован пустой AudioBuffer');
    const samples = buffer.getChannelData(0);
    let peak = 0;
    for (const sample of samples) peak = Math.max(peak, Math.abs(sample));
    if (!(peak > 0.001)) throw new Error('Декодированный сигнал нулевой');
    return JSON.stringify({ samples: buffer.length, sampleRate: buffer.sampleRate, duration: buffer.duration, peak });
  } finally {
    await timed(context.close(), 1500);
  }
}

/** Ждёт настоящее Wails-событие, сохраняя точечный unsubscribe для finally владельца. */
function eventWait(name: string, session: string): { promise: Promise<void>; cancel: () => void } {
  let cancel = () => {};
  const promise = new Promise<void>((resolve, reject) => {
    const stop = Events.On(name, (event) => {
      if (event.data?.session !== session) return;
      cancel();
      resolve();
    });
    const timer = setTimeout(() => {
      cancel();
      reject(new Error(`Не получено ${name}`));
    }, 9000);
    cancel = () => {
      clearTimeout(timer);
      stop();
    };
  });
  // Обработчик установлен немедленно: ошибка OpenPreview не создаёт unhandled rejection ожидания.
  void promise.catch(() => {});
  return { promise, cancel: () => cancel() };
}

/** Запускается только страницей /native-check в явно включённом CLI-режиме.
 * Каждый сценарий фиксирует собственный результат; сбой одного кодека не скрывает остальные.
 * Физический звук и нажатие системного уведомления этим автоматическим режимом не проверяются.
 */
export async function runNativeCheck(host: HTMLElement, changed: (checks: NativeObservation[]) => void): Promise<NativeObservation[]> {
  const checks: NativeObservation[] = [];
  const check = async (name: string, action: () => Promise<string>) => {
    try {
      checks.push({ name, passed: true, details: await action() });
    } catch (error) {
      checks.push({ name, passed: false, details: describe(error) });
    }
    changed([...checks]);
  };
  let fatal = '';
  try {
    const config = await timed(checkService.Config());
    const file = (extension: string): MediaInput => {
      const found = (config.files ?? []).find((item) => item.path.toLowerCase().endsWith(`.${extension}`));
      if (!found) throw new Error(`Нет фикстуры .${extension}`);
      return found;
    };
    for (const extension of ['wav', 'mp3', 'mp4', 'webm']) {
      await check(`${extension}: метаданные, seek и воспроизведение`, () => playback(file(extension), host));
    }
    await check('WAV: фактический возврат loop', () => loop(file('wav'), host));
    for (const extension of ['wav', 'mp3']) await check(`AudioContext: ${extension}, ненулевая волна`, () => decode(file(extension)));
    for (const extension of ['wav', 'mp3', 'mp4', 'webm']) {
      await check(`HTTP HEAD/Range/416: ${extension}`, async () => {
        const media = file(extension);
        const head = await fetchMedia(media.url, { method: 'HEAD' });
        const total = Number(head.headers.get('Content-Length'));
        if (head.status !== 200 || !(total > 200) || (await head.arrayBuffer()).byteLength !== 0)
          throw new Error(`Некорректный HEAD ${head.status}, size=${total}`);
        const range = await fetchMedia(media.url, { headers: { Range: 'bytes=100-199' } });
        const count = (await timed(range.arrayBuffer())).byteLength;
        if (range.status !== 206 || count !== 100 || range.headers.get('Content-Range') !== `bytes 100-199/${total}`)
          throw new Error(`Некорректный Range ${range.status}, bytes=${count}, Content-Range=${range.headers.get('Content-Range')}`);
        const invalid = await fetchMedia(media.url, { headers: { Range: `bytes=${total + 1}-` } });
        await timed(invalid.arrayBuffer());
        if (invalid.status !== 416) throw new Error(`Ожидался 416, получен ${invalid.status}`);
        return JSON.stringify({ total, range: range.status, count, invalid: invalid.status, mime: head.headers.get('Content-Type') });
      });
    }
    if (config.project)
      await check('Копия проекта: чтение Unicode-пути и таймингов через Go', async () => {
        // Только чтение: статус и разметка не делают копию текущим проектом и не пишут её файлы;
        // URL трека регистрирует ProjectService.Media, как для плеера страницы.
        const status = await timed(projects.Status(config.project));
        const view = await timed(timingService.View(config.project));
        if (!status.name || !view.trackPath) throw new Error([...status.problems, ...view.problems].join(' ') || 'Нет трека или названия');
        const track = await timed(projects.Media(view.trackPath));
        if (!track.url) throw new Error('Трек не зарегистрирован медиасервером');
        // Явный --native-check-project ожидает копию с готовой разметкой: имя проверки должно доказывать её чтение.
        const timing: unknown = view.timing;
        if (!timing || typeof timing !== 'object' || Array.isArray(timing) || !('lines' in timing) || !Array.isArray(timing.lines) || !timing.lines.length)
          throw new Error('Для нативной проверки проекта нужна существующая разметка с непустым массивом lines');
        if (!timing.lines.every((line: unknown) => !!line && typeof line === 'object' && !Array.isArray(line)))
          throw new Error('Разметка содержит повреждённые строки');
        const verifiedCount = timing.lines.filter((line: unknown) => !!line && typeof line === 'object' && 'verified' in line && line.verified === true).length;
        return JSON.stringify({
          path: status.path,
          name: status.name,
          lyricsLines: view.lyrics.length,
          lineCount: timing.lines.length,
          verifiedCount,
          trackSha256: view.trackSha256,
          duration: view.duration,
          timingSha256: 'sha256' in timing ? timing.sha256 : null,
          timingDuration: 'duration_decoded' in timing ? timing.duration_decoded : null,
          problems: [...status.problems, ...view.problems]
        });
      });
    await check('Второе нативное окно: loadedmetadata и закрытие', async () => {
      const session = `native-check-${Date.now()}`;
      const ready = eventWait('preview:ready', session);
      let closed: ReturnType<typeof eventWait> | undefined;
      try {
        await timed(native.OpenPreview({ session, mediaUrl: file('mp4').url, title: 'Проверка второго окна SongFrame' }));
        await ready.promise;
        closed = eventWait('preview:closed', session);
        await timed(native.ClosePreview(session));
        await closed.promise;
        return 'Второе окно подтвердило loadedmetadata; владелец получил preview:closed.';
      } finally {
        ready.cancel();
        closed?.cancel();
        await timed(native.ClosePreview(session));
      }
    });
    if (config.project)
      await check('Notification target: настоящий переход события и unsubscribe/remount', async () => {
        const target = { project: config.project, route: '/project/timing' };
        let removed = 0;
        let received = 0;
        let actual: { project: string; route: string } | undefined;
        const first = Events.On('notifications:open', () => {
          removed++;
        });
        first();
        const second = Events.On('notifications:open', (event) => {
          received++;
          actual = event.data;
        });
        try {
          await timed(native.RouteNotification(target));
          const until = performance.now() + 2500;
          while (!actual && performance.now() < until) await delay(30);
          if (removed || received !== 1 || actual?.project !== target.project || actual?.route !== target.route)
            throw new Error(`Неверная доставка: removed=${removed}, received=${received}`);
          const snapshot = await timed(projects.Status(actual.project));
          if (!snapshot.name) throw new Error('Целевой проект не прочитан');
          second();
          await timed(native.RouteNotification(target));
          await delay(150);
          if (received !== 1 || removed) throw new Error('Unsubscribe оставил активный слушатель');
          return JSON.stringify({ target, received, removed, projectName: snapshot.name, osNotificationClick: 'не проверялся' });
        } finally {
          second();
        }
      });
  } catch (error) {
    fatal = describe(error);
  }
  await timed(
    checkService.Complete({ passed: checks.length > 0 && checks.every((item) => item.passed) && !fatal, checks, userAgent: navigator.userAgent, error: fatal })
  );
  return checks;
}
