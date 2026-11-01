/** Контракты браузерного API проверяются в Node без загрузки Storybook и Electron. */
import { describe, expect, it, vi } from 'vitest';
import { createStoryApi, storyFileUrl, STORY_IMAGE_PATH, STORY_VIDEO_PATH } from './storybook';

describe('окружение историй', () => {
  it('сохраняет sync/async сигнатуры и называет ненастроенный метод', async () => {
    const session = createStoryApi();
    expect(typeof session.api.shell.fileUrl(STORY_VIDEO_PATH)).toBe('string');
    expect(() => session.api.shell.pathForFile({} as File)).toThrow('shell.pathForFile');
    expect(() => session.api.diagnostics.reportRendererError({ kind: 'error', message: 'ошибка' })).toThrow('diagnostics.reportRendererError');
    expect(() => session.api.montageWindow.send({ type: 'ready' })).toThrow('montageWindow.send');
    await expect(session.api.projects.close()).rejects.toThrow('projects.close');
  });

  it('отделяет все пять подписок, отписывает слушателей и очищает сессию', () => {
    const first = createStoryApi();
    const second = createStoryApi();
    const checkSubscription = <T>(subscribe: (listener: (value: T) => void) => () => void, emit: (value: T) => void, payload: T): void => {
      const listener = vi.fn();
      const unsubscribe = subscribe(listener);
      emit(payload);
      expect(listener).toHaveBeenCalledTimes(1);
      unsubscribe();
      emit(payload);
      expect(listener).toHaveBeenCalledTimes(1);
      subscribe(listener);
    };
    checkSubscription(first.api.agents.onEvent, first.emit.agentEvent, { jobId: 'job', project: '/mock', sequence: 1, phase: 'test', type: 'started' });
    checkSubscription(first.api.notifications.onOpen, first.emit.notificationOpen, { project: '/mock', route: '/project/scenario' });
    checkSubscription(first.api.environment.onLoginUrl, first.emit.loginUrl, { provider: 'test', url: 'https://example.test/login' });
    checkSubscription(first.api.montageWindow.onMessage, first.emit.montageMessage, { session: 'test', message: { type: 'ready' } });
    checkSubscription(first.api.montageWindow.onClosed, first.emit.montageClosed, 'test');
    const isolated = vi.fn();
    second.api.montageWindow.onClosed(isolated);
    const cleanup = vi.fn();
    first.onCleanup(cleanup);
    first.dispose();
    first.dispose();
    first.emit.montageClosed('первая');
    expect(cleanup).toHaveBeenCalledTimes(1);
    expect(isolated).not.toHaveBeenCalled();
    second.emit.montageClosed('вторая');
    expect(isolated).toHaveBeenCalledWith('вторая');
    expect(() => first.api.montageWindow.onClosed(vi.fn())).toThrow('сессия истории уже закрыта');
  });

  it('отклоняет отложенный ответ закрытой истории и не трогает следующую', async () => {
    let complete = (): void => undefined;
    const first = createStoryApi({
      projects: {
        close: () =>
          new Promise<void>((resolve) => {
            complete = resolve;
          })
      }
    });
    const operation = first.api.projects.close();
    const rejection = expect(operation).rejects.toThrow('сессия истории уже закрыта');
    first.dispose();
    const nextClose = vi.fn(async () => undefined);
    const second = createStoryApi({ projects: { close: nextClose } });
    complete();
    await rejection;
    await second.api.projects.close();
    expect(nextClose).toHaveBeenCalledTimes(1);
  });

  it('отсутствующий метод старого preload изолирован своей сессией и не попадает в следующие истории', () => {
    const normal = createStoryApi();
    const inspect = normal.api.referenceImages.inspect;
    const broken = createStoryApi({}, { missingReferenceImageInspection: true });
    try {
      // Проверяем настоящее отсутствие после guard-обёрток, не вызывая ненастроенный API.
      expect(typeof inspect).toBe('function');
      expect(typeof broken.api.referenceImages.inspect).toBe('undefined');
      expect(Reflect.has(broken.api.referenceImages, 'inspect')).toBe(false);
      expect(normal.api.referenceImages.inspect).toBe(inspect);
      broken.dispose();
      expect(normal.api.referenceImages.inspect).toBe(inspect);
      const next = createStoryApi();
      try {
        expect(typeof next.api.referenceImages.inspect).toBe('function');
        expect(Reflect.has(next.api.referenceImages, 'inspect')).toBe(true);
        expect(next.api.referenceImages.inspect).not.toBe(inspect);
      } finally {
        next.dispose();
      }
    } finally {
      broken.dispose();
      normal.dispose();
    }
  });

  it('разрешает медиа под подпапкой, Windows-пути, кириллицу и query версии', () => {
    const base = 'https://example.test/каталог/iframe.html?id=история';
    expect(storyFileUrl('C:\\макеты с пробелом\\story-video.mp4?v=7', base)).toBe(
      'https://example.test/%D0%BA%D0%B0%D1%82%D0%B0%D0%BB%D0%BE%D0%B3/media/story-video.mp4?v=7'
    );
    expect(storyFileUrl(STORY_IMAGE_PATH, 'https://example.test/demo/iframe.html')).toBe('https://example.test/demo/media/story-image.png');
    expect(storyFileUrl('/чужой/проект/private.png', base)).toContain('/media/missing-story-file');
  });
});
