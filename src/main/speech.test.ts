import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { readPackageSpeech, speechPlan } from './speech';
import { acceptsAudioInput } from './media-catalog';

let project: string;
const write = (path: string, value: unknown): void => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
};

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-speech-'));
  write(join(project, 'plan/scenes.json'), { fps: 30, scenes: [{ id: 'M05', start_frame: 300, end_frame_exclusive: 450 }] });
  write(join(project, 'source/text.md'), '[Куплет]\nПервая строка\nВторая строка\nЧужая строка');
  write(join(project, 'plan/audio/timing.json'), {
    lines: [
      { id: 'l1', source_line: 2, start: 9.8, end: 11.2 },
      { id: 'l2', source_line: 3, start: 11.4, end: 14.6 },
      { id: 'l3', source_line: 4, start: 15.2, end: 17 }
    ]
  });
});
afterEach(() => rmSync(project, { recursive: true, force: true }));

describe('речевой план', () => {
  it('берёт строки окна и начинает срез с начала окна, чтобы губы совпали с песней в монтаже', () => {
    const plan = speechPlan(project, 'M05');
    expect(plan.window).toEqual({ start: 10, end: 15 });
    expect(plan.lines.map((line) => line.text)).toEqual(['Первая строка', 'Вторая строка']);
    expect(plan.proposed).toEqual({ start: 10, end: 15 });
  });

  it('удлиняет срез до длительности запроса и минимума звукового входа модели', () => {
    expect(speechPlan(project, 'M05', { requestSeconds: 6, lipSync: { min: 5, max: 30 } }).proposed).toEqual({ start: 10, end: 16 });
    expect(speechPlan(project, 'M05', { requestSeconds: 4, lipSync: { min: 7, max: 30 } })).toMatchObject({
      proposed: { start: 10, end: 17 },
      lipSync: { min: 7, max: 30 }
    });
  });

  it('срез пакета виден только при рецепте и файле WAV', () => {
    const packageDir = join(project, 'plan/batches/M05-attempt-01');
    write(join(packageDir, 'audio/audio-recipe.json'), { source_interval_seconds: [9.3, 15.1], output: { path: 'speech.wav' } });
    expect(readPackageSpeech(packageDir)).toBeNull();
    write(join(packageDir, 'audio/speech.wav'), 'wav');
    expect(readPackageSpeech(packageDir)).toMatchObject({ start: 9.3, end: 15.1, path: join(packageDir, 'audio/speech.wav') });
  });

  it('звуковой вход определяется по слотам моделей', () => {
    const report = (slots: string[]) => ({
      command: 'image_to_video',
      models: { m: { arguments: {}, slots: Object.fromEntries(slots.map((slot) => [slot, {}])) } }
    });
    expect(acceptsAudioInput([report(['first_image', 'tail_image'])])).toBe(false);
    expect(acceptsAudioInput([report(['first_image']), report(['image_1', 'audio'])])).toBe(true);
  });
});
