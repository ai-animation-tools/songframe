/** Удаление готовых экспортов проверяется на временном проекте; исходники и соседние результаты сохраняются. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobInfo } from '@shared/types';
import { Checks, listReviews } from './checks';
import { Jobs } from './jobs';
import { listBundles, Production } from './production';

let work: string;
let project: string;
let jobs: Jobs;
let production: Production;
let checks: Checks;

function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}

function bundle(path = join(project, 'plan/batches/edit-bundle')): string {
  write(join(path, 'bundle.json'), { shots: [{ status: 'video' }] });
  write(join(path, 'media/source/song.wav'), 'копия песни');
  return path;
}

function review(path = join(project, 'plan/batches/work-package/review.mp4')): string {
  write(path, 'собранная проба');
  write(path.slice(0, -4) + '.json', { shots: [{ id: 'M01' }], total_frames: 90, video_sha256: 'a'.repeat(64) });
  return path;
}

beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'songframe-built-output-'));
  project = join(work, 'clip');
  mkdirSync(project);
  jobs = new Jobs(null, work);
  production = new Production(null, jobs);
  checks = new Checks(jobs);
});

afterEach(() => {
  vi.restoreAllMocks();
  rmSync(work, { recursive: true, force: true });
});

describe('Удаление готовых пакетов и проб', () => {
  it('удаляет папку выбранного экспорта с копиями, сохраняя источники и другой пакет', () => {
    const target = bundle();
    const neighbor = bundle(join(project, 'plan/batches/another-bundle'));
    write(join(project, 'source/song.wav'), 'исходная песня');
    write(join(project, 'assets/shots/M01/original.mp4'), 'платный оригинал');
    expect(listBundles(project)).toHaveLength(2);

    production.removeBundle(project, target);

    expect(existsSync(target)).toBe(false);
    expect(listBundles(project).map((item) => item.dir)).toEqual([neighbor]);
    expect(readFileSync(join(project, 'source/song.wav'), 'utf8')).toBe('исходная песня');
    expect(readFileSync(join(project, 'assets/shots/M01/original.mp4'), 'utf8')).toBe('платный оригинал');
    expect(() => production.removeBundle(project, target)).toThrow(/отсутствует/);
  });

  it('удаляет одну пару MP4 и JSON, сохраняя соседнюю пробу, рабочий пакет и его оригинал', () => {
    const target = review();
    const neighbor = review(join(dirname(target), 'another.mp4'));
    write(join(dirname(target), 'workflow.json'), { shot: 'M01' });
    write(join(dirname(target), 'request/original.mp4'), 'платный оригинал');

    checks.removeReview(project, target);

    expect(existsSync(target)).toBe(false);
    expect(existsSync(target.slice(0, -4) + '.json')).toBe(false);
    expect(listReviews(project).map((item) => item.video)).toEqual([neighbor]);
    expect(readFileSync(join(dirname(target), 'request/original.mp4'), 'utf8')).toBe('платный оригинал');
    expect(existsSync(join(dirname(target), 'workflow.json'))).toBe(true);
    expect(existsSync(dirname(target))).toBe(true);
    expect(() => checks.removeReview(project, target)).toThrow(/отсутствует/);
  });

  it('убирает папку пробы после удаления последней пары MP4 и JSON', () => {
    const target = review(join(project, 'plan/batches/review-M01/review.mp4'));

    checks.removeReview(project, target);

    expect(existsSync(dirname(target))).toBe(false);
    expect(existsSync(join(project, 'plan/batches'))).toBe(true);
    expect(listReviews(project)).toEqual([]);
  });

  it('при удалении экспорта не обходит ссылку внутри media к исходным файлам', () => {
    const target = bundle();
    const original = join(project, 'source/original.mp4');
    write(original, 'платный оригинал');
    symlinkSync(original, join(target, 'media/original.mp4'));

    production.removeBundle(project, target);

    expect(existsSync(target)).toBe(false);
    expect(readFileSync(original, 'utf8')).toBe('платный оригинал');
  });

  it('не трактует относительные пути как разрешение удалить результат', () => {
    const target = bundle();
    const video = review();
    expect(() => production.removeBundle(project, 'plan/batches/edit-bundle')).toThrow(/абсолютный/);
    expect(() => checks.removeReview(project, 'plan/batches/work-package/review.mp4')).toThrow(/абсолютный/);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(video)).toBe(true);
  });

  it('отвергает неполные и посторонние результаты, а также рабочий пакет с bundle.json', () => {
    const incompleteBundle = join(project, 'plan/batches/incomplete');
    write(join(incompleteBundle, 'bundle.json'), {});
    expect(() => production.removeBundle(project, incompleteBundle)).toThrow(/не найден/);
    const workingBundle = bundle(join(project, 'plan/batches/working'));
    write(join(workingBundle, 'workflow.json'), { shot: 'M01' });
    expect(() => production.removeBundle(project, workingBundle)).toThrow(/рабочий пакет/);
    const incompleteReview = join(project, 'plan/batches/incomplete/review.mp4');
    write(incompleteReview, 'неготовая проба');
    write(incompleteReview.slice(0, -4) + '.json', { shots: [] });
    expect(() => checks.removeReview(project, incompleteReview)).toThrow(/не найдена/);
    expect(() => checks.removeReview(project, dirname(incompleteReview))).toThrow();
    expect(existsSync(incompleteReview)).toBe(true);
    expect(existsSync(workingBundle)).toBe(true);
  });

  it.each(['request.json', 'request/request.json'])('сохраняет платный оригинал старого рабочего пакета с маркером %s', (marker) => {
    const target = bundle(join(project, 'plan/batches/legacy-working'));
    write(join(target, marker), { provider: 'test', command: 'image_to_video' });
    const original = join(target, 'request/original.mp4');
    write(original, 'платный оригинал');

    expect(() => production.removeBundle(project, target)).toThrow(/рабочий пакет/);

    expect(readFileSync(original, 'utf8')).toBe('платный оригинал');
    expect(existsSync(join(target, marker))).toBe(true);
    expect(existsSync(join(target, 'bundle.json'))).toBe(true);
  });

  it.each(['source', 'assets/shots', 'plan/batches-other', '../other/plan/batches', 'plan/batches/nested/deeper'])(
    'отвергает путь вне списка plan/batches: %s',
    (base) => {
      const target = bundle(join(project, base, 'export'));
      const video = review(join(target, 'review.mp4'));
      expect(() => production.removeBundle(project, target)).toThrow(/plan\/batches/);
      expect(() => checks.removeReview(project, video)).toThrow(/plan\/batches/);
      expect(existsSync(target)).toBe(true);
      expect(existsSync(video)).toBe(true);
    }
  );

  it('отвергает ссылки на папку экспорта, MP4, JSON и родительскую папку plan/batches', () => {
    const outside = bundle(join(work, 'outside'));
    const outsideVideo = review(join(outside, 'review.mp4'));
    mkdirSync(join(project, 'plan/batches'), { recursive: true });
    const linkedDir = join(project, 'plan/batches/linked');
    symlinkSync(outside, linkedDir, 'dir');
    expect(() => production.removeBundle(project, linkedDir)).toThrow(/ссылку/);
    expect(() => checks.removeReview(project, join(linkedDir, 'review.mp4'))).toThrow(/ссылку/);

    const localBundle = bundle();
    rmSync(join(localBundle, 'bundle.json'));
    symlinkSync(join(outside, 'bundle.json'), join(localBundle, 'bundle.json'));
    expect(() => production.removeBundle(project, localBundle)).toThrow(/ссылку/);
    const localVideo = review();
    rmSync(localVideo);
    symlinkSync(outsideVideo, localVideo);
    expect(() => checks.removeReview(project, localVideo)).toThrow(/ссылку/);
    rmSync(localVideo);
    write(localVideo, 'проба');
    const localManifest = localVideo.slice(0, -4) + '.json';
    rmSync(localManifest);
    symlinkSync(join(outside, 'review.json'), localManifest);
    expect(() => checks.removeReview(project, localVideo)).toThrow(/ссылку/);
    expect(existsSync(localVideo)).toBe(true);

    rmSync(join(project, 'plan/batches'), { recursive: true });
    symlinkSync(work, join(project, 'plan/batches'), 'dir');
    expect(() => production.removeBundle(project, join(project, 'plan/batches/outside'))).toThrow(/ссылку/);
    expect(() => checks.removeReview(project, join(project, 'plan/batches/outside/review.mp4'))).toThrow(/ссылку/);
    expect(readFileSync(outsideVideo, 'utf8')).toBe('собранная проба');
    expect(existsSync(join(outside, 'bundle.json'))).toBe(true);
  });

  it('не удаляет появившийся результат до завершения задания его сборки', () => {
    const job = { id: 'active', status: 'running' } as JobInfo;
    const start = vi.spyOn(jobs, 'start').mockReturnValue(job);
    vi.spyOn(jobs, 'get').mockImplementation((id) => (id === job.id ? job : null));
    const target = join(project, 'plan/batches/active-bundle');
    production.exportBundle(project, { target, copy: false });
    bundle(target);
    expect(() => production.removeBundle(project, target)).toThrow(/ещё собирается/);

    checks.buildReview(project, { shots: ['M01'], planOnly: false });
    const args = start.mock.calls.at(-1)![3][0].args;
    const video = review(args[args.indexOf('--output') + 1]);
    expect(() => checks.removeReview(project, video)).toThrow(/ещё собирается/);
    expect(existsSync(target)).toBe(true);
    expect(existsSync(video)).toBe(true);

    job.status = 'done';
    production.removeBundle(project, target);
    checks.removeReview(project, video);
    expect(existsSync(target)).toBe(false);
    expect(existsSync(video)).toBe(false);
  });
});
