import { describe, expect, it, vi } from 'vitest';
import { createMontagePlayback, cutPreviewWindow } from './montagePlayback';

class AudioStub {
  private time = 0;
  paused = true;
  ended = false;
  readonly seeks: number[] = [];
  play = vi.fn((): Promise<void> => {
    this.paused = false;
    return Promise.resolve();
  });
  pause = vi.fn((): void => {
    this.paused = true;
  });

  get currentTime(): number {
    return this.time;
  }

  set currentTime(value: number) {
    this.seeks.push(value);
    this.time = value;
    this.ended = false;
  }

  // Ход медиачасов не является пользовательским seek и не должен попадать в список перемоток.
  advance(time: number): void {
    this.time = time;
  }
}

function setup(loop = false) {
  const audio = new AudioStub();
  const frames = vi.fn<(frame: number) => void>();
  const playing = vi.fn<(playing: boolean) => void>();
  const errors = vi.fn<(error: unknown) => void>();
  const range = { start: 6000, end: 6360, loop };
  const playback = createMontagePlayback(audio, { range: () => range, onFrame: frames, onPlaying: playing, onError: errors });
  return { audio, frames, playing, errors, range, playback };
}

describe('воспроизведение музыкального участка монтажа', () => {
  it('ограничивает проверку склейки двумя секундами и границами музыкального участка', () => {
    expect(cutPreviewWindow(150, 360)).toEqual({ start: 90, end: 210 });
    expect(cutPreviewWindow(20, 60)).toEqual({ start: 0, end: 60 });
    expect(cutPreviewWindow(0, 60)).toBeNull();
    expect(cutPreviewWindow(60, 60)).toBeNull();
  });

  it('проверяет стык с повтором и останавливает его на последнем кадре без повтора', async () => {
    for (const loop of [false, true]) {
      const audio = new AudioStub();
      const frames = vi.fn<(frame: number) => void>();
      const playback = createMontagePlayback(audio, {
        range: () => ({ start: 6000, end: 6360, loop }),
        previewWindow: () => ({ start: 90, end: 210 }),
        onFrame: frames,
        onPlaying: vi.fn(),
        onError: vi.fn()
      });
      playback.seek(90);
      playback.play();
      await Promise.resolve();
      audio.advance((6000 + 210) / 30);
      playback.tick();
      expect(audio.currentTime).toBe((6000 + (loop ? 90 : 209)) / 30);
      expect(playback.isPlaying()).toBe(loop);
      expect(frames).toHaveBeenLastCalledWith(loop ? 90 : 209);
    }
  });
  it('читает отставшие часы без перемотки аудио и публикует кадр только при его изменении', async () => {
    const { audio, playback, frames } = setup();
    playback.seek(0);
    playback.play();
    await Promise.resolve();
    frames.mockClear();

    audio.advance(200.95);
    playback.tick();
    playback.tick();
    expect(frames.mock.calls).toEqual([[28]]);
    expect(audio.seeks).toEqual([200]);
    audio.advance(200.97);
    playback.tick();
    expect(frames.mock.calls).toEqual([[28], [29]]);
    expect(audio.seeks).toEqual([200]);
  });

  it('перематывает явный запрос точно на один кадр и ограничивает его музыкальным участком', () => {
    const { audio, playback, frames } = setup();
    playback.seek(1);
    expect(audio.currentTime).toBeCloseTo(200 + 1 / 30);
    playback.seek(-1);
    playback.seek(1000);
    expect(audio.seeks).toEqual([6001 / 30, 200, 6359 / 30]);
    expect(frames.mock.calls).toEqual([[1], [0], [359]]);
  });

  it('переходит в начало выделенного участка, сохраняя текущее состояние воспроизведения', async () => {
    const { audio, playback, frames } = setup();
    playback.seek(30);
    playback.seek(0);
    expect(audio.currentTime).toBe(200);
    expect(audio.paused).toBe(true);
    expect(frames).toHaveBeenLastCalledWith(0);

    playback.play();
    await Promise.resolve();
    audio.advance(205);
    playback.tick();
    playback.seek(0);
    expect(audio.currentTime).toBe(200);
    expect(audio.paused).toBe(false);
    expect(playback.isPlaying()).toBe(true);
    expect(frames).toHaveBeenLastCalledWith(0);
  });

  it('повторяет участок внутри трека одним seek без нового play', async () => {
    const { audio, playback, frames } = setup(true);
    playback.seek(0);
    playback.play();
    await Promise.resolve();
    audio.advance(211.9);
    playback.tick();
    audio.advance(212.1);
    playback.tick();
    playback.tick();

    expect(audio.seeks).toEqual([200, 200]);
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.paused).toBe(false);
    expect(frames.mock.calls).toEqual([[0], [357], [0]]);
  });

  it('обрабатывает естественный конец трека один раз независимо от порядка pause, ended и tick', async () => {
    for (const first of ['pause', 'ended', 'tick'] as const) {
      const { audio, playback } = setup(true);
      playback.seek(0);
      playback.play();
      await Promise.resolve();
      audio.advance(212);
      audio.paused = true;
      audio.ended = true;

      if (first === 'pause') playback.onPause();
      else if (first === 'ended') playback.onEnded();
      else playback.tick();
      playback.onPause();
      playback.onEnded();
      playback.tick();

      expect(audio.seeks).toEqual([200, 200]);
      expect(audio.play).toHaveBeenCalledTimes(2);
      expect(playback.isPlaying()).toBe(true);
    }
  });

  it('останавливает участок без loop и оставляет курсор на последнем кадре', async () => {
    const { audio, playback, frames } = setup();
    playback.play();
    await Promise.resolve();
    audio.advance(212.2);
    playback.tick();
    playback.tick();
    expect(audio.paused).toBe(true);
    expect(playback.isPlaying()).toBe(false);
    expect(frames.mock.calls).toEqual([[359]]);
    expect(audio.seeks).toEqual([]);
  });

  it('штатная пауза отменяет ожидающий play без ошибки и не мешает следующему запуску', async () => {
    const { audio, playback, errors, playing } = setup();
    let rejectFirst!: (error: unknown) => void;
    audio.play.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectFirst = reject;
        })
    );
    playback.play();
    playback.play();
    expect(audio.play).toHaveBeenCalledTimes(1);
    playback.pause();
    playback.play();
    rejectFirst(new DOMException('play() interrupted by pause()', 'AbortError'));
    await Promise.resolve();

    expect(errors).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(2);
    expect(playback.isPlaying()).toBe(true);
    expect(playing.mock.calls).toEqual([[true], [false], [true]]);
    playback.onPause();
    expect(playback.isPlaying()).toBe(true);
  });

  it('dispose отменяет ожидающий запуск и игнорирует поздние события старого источника', async () => {
    const { audio, playback, errors, frames, playing } = setup(true);
    let rejectPlay!: (error: unknown) => void;
    audio.play.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPlay = reject;
        })
    );
    playback.play();
    playback.dispose();
    frames.mockClear();
    playing.mockClear();
    rejectPlay(new DOMException('source changed', 'AbortError'));
    await Promise.resolve();
    audio.ended = true;
    playback.onEnded();
    playback.onPause();
    playback.tick();
    playback.seek(12);
    playback.play();

    expect(errors).not.toHaveBeenCalled();
    expect(frames).not.toHaveBeenCalled();
    expect(playing).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(audio.seeks).toEqual([]);
  });

  it('показывает ошибку актуального play, включая неожиданную отмену без команды паузы', async () => {
    for (const error of [new Error('decode failed'), new DOMException('external interruption', 'AbortError')]) {
      const { audio, playback, errors } = setup();
      audio.play.mockRejectedValueOnce(error);
      playback.play();
      await Promise.resolve();
      expect(errors).toHaveBeenCalledWith(error);
      expect(playback.isPlaying()).toBe(false);
      expect(audio.paused).toBe(true);
    }
  });

  it('остановленный pending play не возобновляется от запоздалого ended', async () => {
    const { audio, playback, errors } = setup(true);
    let rejectPlay!: (error: unknown) => void;
    audio.play.mockImplementationOnce(
      () =>
        new Promise<void>((_resolve, reject) => {
          rejectPlay = reject;
        })
    );
    playback.play();
    playback.pause();
    audio.ended = true;
    playback.onPause();
    playback.onEnded();
    playback.tick();
    rejectPlay(new DOMException('cancelled', 'AbortError'));
    await Promise.resolve();
    expect(errors).not.toHaveBeenCalled();
    expect(audio.play).toHaveBeenCalledTimes(1);
    expect(playback.isPlaying()).toBe(false);
  });
});
