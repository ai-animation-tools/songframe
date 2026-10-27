interface ThumbnailJob {
  url: string;
  controller: AbortController;
  state: 'queued' | 'running' | 'done';
  resolve: (data: string) => void;
  reject: (error: unknown) => void;
}

const queue: ThumbnailJob[] = [];
let running = 0;

/** Берём первый кадр нативным декодером и сразу освобождаем видео; музыка и исходный файл не изменяются. */
function firstFrame(url: string, signal: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const video = document.createElement('video');
    let finished = false;
    const timeout = window.setTimeout(() => finish(new Error('Не удалось дождаться кадра видео.')), 15000);
    const abort = (): void => finish(new DOMException('Загрузка превью отменена.', 'AbortError'));
    const failed = (): void => finish(new Error('Не удалось прочитать кадр видео.'));
    const loaded = (): void => {
      if (!video.videoWidth || !video.videoHeight || video.readyState < 2) return;
      try {
        const canvas = document.createElement('canvas');
        canvas.width = 320;
        canvas.height = 180;
        const context = canvas.getContext('2d');
        if (!context) throw new Error('Не удалось подготовить изображение превью.');
        const scale = Math.min(canvas.width / video.videoWidth, canvas.height / video.videoHeight);
        const width = video.videoWidth * scale;
        const height = video.videoHeight * scale;
        context.fillStyle = '#000';
        context.fillRect(0, 0, canvas.width, canvas.height);
        context.drawImage(video, (canvas.width - width) / 2, (canvas.height - height) / 2, width, height);
        finish(null, canvas.toDataURL('image/jpeg', 0.8));
      } catch (error) {
        finish(error);
      }
    };
    function finish(error: unknown, data?: string): void {
      if (finished) return;
      finished = true;
      window.clearTimeout(timeout);
      signal.removeEventListener('abort', abort);
      video.removeEventListener('loadeddata', loaded);
      video.removeEventListener('error', failed);
      video.pause();
      video.removeAttribute('src');
      video.load();
      if (error) reject(error);
      else resolve(data!);
    }
    signal.addEventListener('abort', abort, { once: true });
    video.addEventListener('loadeddata', loaded);
    video.addEventListener('error', failed);
    video.muted = true;
    video.playsInline = true;
    video.preload = 'auto';
    video.crossOrigin = 'anonymous';
    if (signal.aborted) abort();
    else {
      video.src = url;
      video.load();
    }
  });
}

function pump(): void {
  // Одновременно декодируем максимум два превью, чтобы каталог не мешал звуку и основному плееру.
  while (running < 2 && queue.length) {
    const job = queue.shift()!;
    if (job.state !== 'queued') continue;
    job.state = 'running';
    running += 1;
    void firstFrame(job.url, job.controller.signal)
      .then(job.resolve, job.reject)
      .finally(() => {
        job.state = 'done';
        running -= 1;
        pump();
      });
  }
}

/** Невидимые карточки могут отменить как ожидающую задачу, так и уже начатое чтение кадра. */
export function requestSourceThumbnail(url: string): { promise: Promise<string>; cancel(): void } {
  let job!: ThumbnailJob;
  const promise = new Promise<string>((resolve, reject) => {
    job = { url, controller: new AbortController(), state: 'queued', resolve, reject };
    queue.push(job);
    pump();
  });
  return {
    promise,
    cancel: (): void => {
      if (job.state === 'done') return;
      if (job.state === 'queued') {
        queue.splice(queue.indexOf(job), 1);
        job.state = 'done';
        job.reject(new DOMException('Загрузка превью отменена.', 'AbortError'));
      } else job.controller.abort();
    }
  };
}
