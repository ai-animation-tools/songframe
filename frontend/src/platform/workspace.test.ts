import { describe, it, expect, vi } from 'vitest';
import { parseMedia, parseSnapshot, subscribeDeferred, validTiming } from './workspace';

/** Независимая fixture проверяет nullable DTO и физические номера без обращения к сервису или диску. */
const snapshot = () => ({
  path: '/tmp/Копия',
  name: 'Песня',
  lyricsText: '[Куплет]\nТекст\n',
  timing: { lines: [{ id: 1, source_line: 2, start: 0.2, end: 1.3, verified: true, note: 'Не изменять' }] },
  track: null,
  trackSha256: null,
  duration: null,
  problems: [],
  blocked: false
});
const flush = async () => {
  await Promise.resolve();
  await Promise.resolve();
};
describe('read-only snapshot', () => {
  it('читает старую разметку без дописывания метаданных и ручных границ', () => {
    const raw = snapshot(),
      before = structuredClone(raw),
      value = parseSnapshot(raw);
    expect(value.timing).toEqual(before.timing);
    expect(raw).toEqual(before);
    expect(value.timing).not.toHaveProperty('sections');
  });
  it('повреждённая разметка оставляет текст и объяснение', () => {
    const value = parseSnapshot({ ...snapshot(), timing: { lines: [null] } });
    expect(value.timing).toBeNull();
    expect(value.lyricsText).toContain('Текст');
    expect(value.problems).toHaveLength(1);
  });
  it.each([{ problems: null }, { track: undefined }, { duration: '1' }, { blocked: 'false' }, { path: '' }])('отклоняет неверную форму DTO %j', (broken) =>
    expect(() => parseSnapshot({ ...snapshot(), ...broken })).toThrow()
  );
  it('не отдаёт частичную публикацию при blocked', () => expect(() => parseSnapshot({ ...snapshot(), blocked: true })).toThrow());
  it('предупреждает о другом треке и изменённых физических строках', () => {
    const value = parseSnapshot({
      ...snapshot(),
      trackSha256: 'new',
      timing: { sha256: 'old', lines: [{ id: 1, source_line: 1, start: 0, end: 1, verified: true }] }
    });
    expect(value.problems).toHaveLength(2);
    expect(value.problems.join(' ')).toContain('другого трека');
  });
  it('не принимает повреждённые acoustic candidates', () => {
    for (const candidate of [
      { source_line: 0, start: 0, end: 1, reason: 'x' },
      { source_line: 2, start: -1, end: 1, reason: 'x' },
      { source_line: 2, start: 0, end: 1, reason: '' },
      { source_line: 2, start: 0, end: 1, reason: 'x', acoustic_score: 2 }
    ]) {
      expect(validTiming({ ...snapshot().timing, candidates: [candidate] })).toBe(false);
    }
  });
  it('принимает только loopback URL медиа', () => {
    expect(parseMedia({ path: '/tmp/файл.mp3', url: 'http://127.0.0.1:9000/media/1/file.mp3', kind: 'audio' }).kind).toBe('audio');
    expect(() => parseMedia({ path: 'x', url: 'file:///etc/passwd', kind: 'audio' })).toThrow();
  });
});
describe('жизненный цикл асинхронной подписки', () => {
  it('не регистрирует слушатель после unmount во время import', async () => {
    let resolve!: (value: { on: () => () => void }) => void;
    const on = vi.fn(() => vi.fn());
    const off = subscribeDeferred(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
      'event',
      (value) => value,
      vi.fn()
    );
    off();
    resolve({ on });
    await flush();
    expect(on).not.toHaveBeenCalled();
  });
  it('снимает только собственный слушатель один раз и игнорирует позднее событие', async () => {
    let emit!: (event: { data: unknown }) => void;
    const cancel = vi.fn(),
      listener = vi.fn();
    const off = subscribeDeferred(
      async () => ({
        on: (_name, callback) => {
          emit = callback;
          return cancel;
        }
      }),
      'event',
      (value) => value,
      listener
    );
    await flush();
    emit({ data: 1 });
    off();
    off();
    emit({ data: 2 });
    expect(listener).toHaveBeenCalledExactlyOnceWith(1);
    expect(cancel).toHaveBeenCalledTimes(1);
  });
  it('повторный mount не умножает активные callbacks', async () => {
    const active = new Set<(event: { data: unknown }) => void>();
    const load = async () => ({
      on: (_name: string, listener: (event: { data: unknown }) => void) => {
        active.add(listener);
        return () => {
          active.delete(listener);
        };
      }
    });
    const listener = vi.fn();
    for (let index = 0; index < 3; index++) {
      const off = subscribeDeferred(load, 'event', (value) => value, listener);
      await flush();
      expect(active.size).toBe(1);
      off();
      expect(active.size).toBe(0);
    }
  });
  it('ошибку import сообщает активному владельцу', async () => {
    const failed = vi.fn();
    subscribeDeferred(
      async () => {
        throw new Error('import');
      },
      'event',
      (value) => value,
      vi.fn(),
      failed
    );
    await flush();
    expect(failed).toHaveBeenCalledTimes(1);
  });
});
