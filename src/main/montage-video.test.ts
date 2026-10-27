/** Сохранение MP4 не должно перезаписать исходники или выдать недособранную пробу за готовую. */
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { copyMontageVideo, montageVideoPath } from './montage-video';

const temporary: string[] = [];
function fixture(): { project: string; video: string } {
  const project = mkdtempSync(join(tmpdir(), 'songframe-montage-video-'));
  temporary.push(project);
  const directory = join(project, 'plan/batches/review-manual-test');
  mkdirSync(directory, { recursive: true });
  const video = join(directory, 'review.mp4');
  writeFileSync(video, 'готовый ролик');
  return { project, video };
}
afterEach(() => temporary.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })));

describe('выгрузка монтажной пробы', () => {
  it('не копирует видео до появления итогового рецепта', async () => {
    const { project, video } = fixture();
    expect(() => montageVideoPath(project, video)).toThrow('не завершён');
    await expect(copyMontageVideo(project, video, join(project, 'результат.mp4'))).rejects.toThrow();
  });

  it('сохраняет точные байты результата и добавляет расширение', async () => {
    const { project, video } = fixture();
    writeFileSync(video.slice(0, -4) + '.json', JSON.stringify({ video_sha256: 'hash', total_frames: 30 }));
    const result = await copyMontageVideo(project, video, join(project, 'проба'));
    expect(result).toBe(join(project, 'проба.mp4'));
    expect(readFileSync(result)).toEqual(readFileSync(video));
  });

  it('сохраняет оригинал при выборе защищённого назначения', async () => {
    const { project, video } = fixture();
    writeFileSync(video.slice(0, -4) + '.json', JSON.stringify({ video_sha256: 'hash', total_frames: 30 }));
    mkdirSync(join(project, 'source'));
    const original = join(project, 'source/original.mp4');
    writeFileSync(original, 'исходник');
    await expect(copyMontageVideo(project, video, original)).rejects.toThrow('Выберите папку');
    expect(readFileSync(original, 'utf8')).toBe('исходник');
    expect(() => montageVideoPath(project, original)).toThrow('не найдена');
  });
});
