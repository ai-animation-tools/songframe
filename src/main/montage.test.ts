/** Проверки хранения и запуска монтажа работают на временном проекте без Python и видеокодирования. */
import { createHash } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MontageDraft } from '@shared/montage';
import type { JobInfo } from '@shared/types';
import type { Jobs } from './jobs';
import { Montage } from './montage';

let project: string;
let montage: Montage;
const job = { id: 'local-review', kind: 'review', status: 'running' } as JobInfo;
const start = vi.fn<Jobs['start']>(() => job);

function file(path: string, content: string): void {
  mkdirSync(dirname(join(project, path)), { recursive: true });
  writeFileSync(join(project, path), content);
}

function json(path: string, value: unknown): void {
  file(path, JSON.stringify(value));
}

function read(path: string): unknown {
  return JSON.parse(readFileSync(join(project, path), 'utf8'));
}

function draft(): MontageDraft {
  const view = montage.view(project);
  return {
    schema_version: 1,
    name: 'Новая проба',
    audio: { path: 'source/track.mp3', start_frame: 0, end_frame_exclusive: 60 },
    clips: ['M01', 'M02'].map((scene) => ({
      id: `clip-${scene}`,
      scene,
      path: `assets/shots/${scene}/original.mp4`,
      kind: 'video',
      source_start_frame: 0,
      source_end_frame_exclusive: 30,
      source_frames: null
    })),
    base_scenes_sha256: view.scenesSha256,
    base_manifest_sha256: view.manifestSha256
  };
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-montage-'));
  montage = new Montage({ start } as unknown as Jobs);
  start.mockClear();
  file('source/track.mp3', 'песня');
  file('source/text.md', '[Куплет]\nТекст песни\n');
  json('source/manifest.json', { schema_version: 1, track: { path: 'track.mp3', sha256: 'a'.repeat(64), duration_seconds: 4 } });
  json('plan/scenes.json', {
    schema_version: 1,
    fps: 30,
    sequences: [{ id: 'intro', title: 'Вступление' }],
    scenes: [
      { id: 'M01', title: 'Первый план', sequence: 'intro', start_frame: 0, end_frame_exclusive: 30 },
      { id: 'M02', sequence: 'intro', start_frame: 30, end_frame_exclusive: 60 },
      { id: 'M03', title: 'Карточка', start_frame: 60, end_frame_exclusive: 120 }
    ]
  });
  for (const scene of ['M01', 'M02']) {
    file(`assets/shots/${scene}/original.mp4`, `оригинал ${scene}`);
    file(`assets/shots/${scene}/video.mp4`, `монтаж ${scene}`);
    json(`assets/shots/${scene}/manifest.json`, {
      generation: { original: { path: 'original.mp4' }, original_media: { duration: '2.000', r_frame_rate: '24/1', nb_frames: '48' } },
      accepted_edit: { video: { path: 'video.mp4' }, frames: 30, fps: 30 }
    });
  }
  file('plan/animatic/cards/M03.png', 'карточка');
});

afterEach(() => rmSync(project, { recursive: true, force: true }));

describe('каталог и хранение', () => {
  it('возвращает строки песни на абсолютной кадровой оси и отключает устаревшую разметку', () => {
    const timing = {
      version: 2,
      sha256: 'a'.repeat(64),
      lines: [{ id: 7, source_line: 2, start: 1.25, end: 2.5 }],
      sections: []
    };
    json('plan/audio/timing.json', timing);
    expect(montage.view(project).lyricLines).toEqual([{ id: 7, text: 'Текст песни', startFrame: 38, endFrame: 75 }]);
    json('plan/audio/timing.json', { ...timing, sha256: 'b'.repeat(64) });
    expect(montage.view(project)).toMatchObject({ lyricLines: [], lyricProblem: expect.stringContaining('другому треку') });
    json('plan/audio/timing.json', { ...timing, lines: [{ ...timing.lines[0], source_line: 1 }] });
    expect(montage.view(project)).toMatchObject({ lyricLines: [], lyricProblem: expect.stringContaining('не соответствует тексту') });
    json('plan/audio/timing.json', { ...timing, lines: {} });
    expect(montage.view(project)).toMatchObject({ lyricLines: [], lyricProblem: expect.stringContaining('недоступна') });
  });

  it('читает канонические границы, длины оригинала/монтажа и карточки с переносимыми путями', () => {
    const view = montage.view(project);
    expect(view.scenarioStatus).toBe('ready');
    expect(view.trackPath).toBe('source/track.mp3');
    expect(view.duration).toBe(4);
    expect(view.scenes).toEqual([
      { id: 'M01', title: 'Первый план', startFrame: 0, endFrame: 30 },
      { id: 'M02', title: 'Вступление', startFrame: 30, endFrame: 60 },
      { id: 'M03', title: 'Карточка', startFrame: 60, endFrame: 120 }
    ]);
    expect(view.sources.filter((source) => source.scene === 'M01').map((source) => [source.original, source.frames])).toEqual([
      [true, 60],
      [false, 30]
    ]);
    expect(view.sources.find((source) => source.scene === 'M03')).toMatchObject({ kind: 'card', frames: null, path: 'plan/animatic/cards/M03.png' });
    expect(view.manifestSha256.M01).toBe(
      createHash('sha256')
        .update(readFileSync(join(project, 'assets/shots/M01/manifest.json')))
        .digest('hex')
    );
    expect(view.problems).toEqual([]);
    expect(view.scenesSha256).toBe(
      createHash('sha256')
        .update(readFileSync(join(project, 'plan/scenes.json')))
        .digest('hex')
    );
    expect(start).not.toHaveBeenCalled();
  });

  // Недоступный сценарий должен остановить чтение до музыки, пакетов и черновиков.
  // Файлы вместо каталогов обнаружат случайное продолжение обхода материалов.
  function unavailableScenario(status: 'missing' | 'empty' | 'invalid', problem: string): void {
    file('source/manifest.json', '{ повреждённая музыка');
    file('plan/batches', 'не каталог пакетов');
    file('plan/awaiting', 'не каталог очереди');
    file('plan/montage', 'не каталог черновиков');
    expect(montage.view(project)).toEqual({
      scenarioStatus: status,
      trackPath: null,
      trackSha256: null,
      duration: null,
      lyricLines: [],
      lyricProblem: null,
      scenes: [],
      sources: [],
      scenesSha256: '',
      manifestSha256: {},
      saved: [],
      problems: [problem]
    });
    expect(start).not.toHaveBeenCalled();
  }

  it('объясняет отсутствие сценария без технических ошибок и чтения остальных материалов', () => {
    rmSync(join(project, 'plan/scenes.json'));
    unavailableScenario('missing', 'Сначала нужен сценарий. Создайте его на странице «Сценарий».');
  });

  it('отличает корректный сценарий без сцен от отсутствующего и повреждённого', () => {
    json('plan/scenes.json', { schema_version: 1, fps: 30, scenes: [] });
    unavailableScenario('empty', 'В сценарии пока нет сцен. Добавьте их на странице «Сценарий».');
  });

  it('останавливает чтение материалов, если вместо файла сценария находится каталог', () => {
    rmSync(join(project, 'plan/scenes.json'));
    mkdirSync(join(project, 'plan/scenes.json'));
    unavailableScenario('invalid', 'Не удалось прочитать сценарий. Проверьте и исправьте его на странице «Сценарий».');
  });

  it.each([
    ['некорректный JSON', '{ повреждённый сценарий'],
    ['массив вместо сценария', '[]'],
    ['null вместо сценария', 'null'],
    ['строку вместо сценария', '"сценарий"'],
    ['неизвестную версию', JSON.stringify({ schema_version: 2, fps: 30, scenes: [] })],
    ['отсутствующую версию', JSON.stringify({ fps: 30, scenes: [] })],
    ['другую кадровую сетку', JSON.stringify({ schema_version: 1, fps: 24, scenes: [] })],
    ['повреждённый список сцен', JSON.stringify({ schema_version: 1, fps: 30, scenes: {} })]
  ])('объясняет %s без внутренних путей и деталей JSON', (_label, content) => {
    file('plan/scenes.json', content);
    unavailableScenario('invalid', 'Не удалось прочитать сценарий. Проверьте и исправьте его на странице «Сценарий».');
  });

  it.each([
    ['неверный код', { id: 'не сцена', start_frame: 30, end_frame_exclusive: 60 }],
    ['повторный код', { id: 'M01', start_frame: 30, end_frame_exclusive: 60 }],
    ['пустые границы', { id: 'M02', start_frame: 30, end_frame_exclusive: 30 }],
    ['дробные границы', { id: 'M02', start_frame: 30.5, end_frame_exclusive: 60 }],
    ['не объект', null]
  ])('не возвращает часть каталога, если следующая сцена содержит %s', (_label, invalid) => {
    json('plan/scenes.json', {
      schema_version: 1,
      fps: 30,
      scenes: [{ id: 'M01', start_frame: 0, end_frame_exclusive: 30 }, invalid]
    });
    unavailableScenario('invalid', 'Не удалось прочитать сценарий. Проверьте и исправьте его на странице «Сценарий».');
  });

  it('сохраняет доступность сценария при повреждённом манифесте материалов', () => {
    json('assets/shots/M01/manifest.json', []);
    const view = montage.view(project);
    expect(view.scenarioStatus).toBe('ready');
    expect(view.scenes).toHaveLength(3);
    expect(view.sources.some((source) => source.scene === 'M02')).toBe(true);
    expect(view.problems).toContain('M01: Не удалось прочитать описание материалов сцены. Файл сохранён; исправьте его или перенесите в резервную папку.');
    expect(view.problems.some((problem) => problem.includes('JSON-объект'))).toBe(false);
  });

  it('добавляет скачанные рабочие оригиналы без запроса метаданных к Python', () => {
    json('plan/batches/M03-attempt/workflow.json', { shot: 'M03', request_dir: 'requests/video-01' });
    json('plan/batches/M03-attempt/requests/video-01/request.json', { kind: 'video', provider: 'kling' });
    json('plan/batches/M03-attempt/requests/video-01/attempt.json', { downloads: [{ path: 'download.mp4' }] });
    file('plan/batches/M03-attempt/requests/video-01/download.mp4', 'скачанный ролик');
    expect(montage.view(project).sources.find((source) => source.scene === 'M03')).toMatchObject({
      kind: 'video',
      frames: null,
      original: true,
      attempt: true,
      path: 'plan/batches/M03-attempt/requests/video-01/download.mp4'
    });
  });

  it('сохраняет незавершённый черновик и открывает его после переноса проекта', () => {
    const value = draft();
    value.audio.end_frame_exclusive = 90;
    const saved = montage.save(project, value);
    expect(saved.id).toMatch(/^[a-f0-9-]{36}$/);
    expect(montage.view(project).saved).toEqual([saved]);
    const moved = `${project}-moved`;
    renameSync(project, moved);
    project = moved;
    expect(montage.load(project, saved.id)).toEqual(value);
    expect(readFileSync(join(project, `plan/montage/${saved.id}.json`), 'utf8')).not.toContain(project);
    expect(() => montage.export(project, value)).toThrow(/совпадать/);
  });

  it('не перезаписывает повреждённый существующий черновик', () => {
    const value = draft();
    const saved = montage.save(project, value);
    const path = `plan/montage/${saved.id}.json`;
    file(path, '{ неверный JSON');
    expect(() => montage.save(project, { ...value, name: 'Замена' }, saved.id)).toThrow(/Не удалось прочитать/);
    expect(readFileSync(join(project, path), 'utf8')).toBe('{ неверный JSON');
    expect(montage.view(project).problems.some((problem) => problem.includes(saved.id))).toBe(true);
    expect(() => montage.load(project, '../other')).toThrow(/идентификатор/);
  });

  it('сохраняет возможность открыть и сохранить устаревший черновик после изменения комплекта', () => {
    const value = draft();
    value.clips[0].path = 'assets/shots/M01/video.mp4';
    value.clips[0].source_frames = 30;
    const saved = montage.save(project, value);
    const manifest = read('assets/shots/M01/manifest.json') as { accepted_edit: { frames: number } };
    manifest.accepted_edit.frames = 15;
    json('assets/shots/M01/manifest.json', manifest);
    expect(montage.load(project, saved.id)).toEqual(value);
    expect(montage.save(project, value, saved.id).id).toBe(saved.id);
    expect(start).not.toHaveBeenCalled();
  });

  it('сохраняет исправленный путь поверх прежнего черновика после переноса исходника', () => {
    const value = draft();
    const saved = montage.save(project, value);
    const oldPath = value.clips[0].path;
    const newPath = 'assets/shots/M01/relocated-original.mp4';
    renameSync(join(project, oldPath), join(project, newPath));
    value.clips[0].path = newPath;
    expect(montage.save(project, value, saved.id).id).toBe(saved.id);
    expect(montage.load(project, saved.id)).toEqual(value);
    expect(start).not.toHaveBeenCalled();
  });

  it('не перезаписывает читаемый JSON с повреждённой структурой', () => {
    const value = draft();
    const saved = montage.save(project, value);
    const path = `plan/montage/${saved.id}.json`;
    json(path, { ...value, clips: 'вместо массива' });
    const previous = readFileSync(join(project, path), 'utf8');
    expect(() => montage.save(project, value, saved.id)).toThrow(/структура/);
    expect(readFileSync(join(project, path), 'utf8')).toBe(previous);
  });
});

describe('проверка монтажа', () => {
  it('отклоняет дробные/бесконечные кадры, повторные сцены и выход за известный оригинал', () => {
    for (const invalid of [NaN, Infinity, -1, 1.5]) {
      const value = draft();
      value.clips[0].source_start_frame = invalid;
      expect(() => montage.save(project, value)).toThrow(/кадровые/);
    }
    const repeated = draft();
    repeated.clips[1].scene = 'M01';
    expect(() => montage.save(project, repeated)).toThrow(/неповторяющимися/);
    const tooLong = draft();
    tooLong.clips[0].source_end_frame_exclusive = 61;
    expect(() => montage.save(project, tooLong)).toThrow(/исходника/);
    expect(start).not.toHaveBeenCalled();
  });

  it('отклоняет отсутствующие и непереносимые пути', () => {
    for (const path of ['../video.mp4', '/tmp/video.mp4', 'C:\\video.mp4', 'C:/video.mp4', 'assets/missing.mp4']) {
      const value = draft();
      value.clips[0].path = path;
      expect(() => montage.save(project, value)).toThrow();
    }
    expect(start).not.toHaveBeenCalled();
  });

  it('проверяет длину видеодорожки и конец музыки перед запуском', () => {
    const mismatch = draft();
    mismatch.audio.end_frame_exclusive = 61;
    expect(() => montage.export(project, mismatch)).toThrow(/совпадать/);
    const outside = draft();
    outside.audio.start_frame = 61;
    outside.audio.end_frame_exclusive = 121;
    expect(() => montage.apply(project, outside)).toThrow(/музыки/);
    expect(start).not.toHaveBeenCalled();
  });
});

describe('локальные задания', () => {
  it('экспортирует явный build_review spec и сохраняет draft отдельно от выходного рецепта', () => {
    const value = draft();
    value.audio.start_frame = 15;
    value.audio.end_frame_exclusive = 75;
    const result = montage.export(project, value);
    expect(result.job).toBe(job);
    expect(result.video).toMatch(/^plan\/batches\/review-manual-[a-f0-9-]+\/review\.mp4$/);
    const spec = result.video.replace('review.mp4', 'review-spec.json');
    expect(read(spec)).toEqual({
      schema_version: 1,
      shots: value.clips.map(({ scene, path, kind, source_start_frame, source_end_frame_exclusive }) => ({
        scene,
        path,
        kind,
        source_start_frame,
        source_end_frame_exclusive
      })),
      audio: { path: 'source/track.mp3', start_frame: 15 }
    });
    expect(read(result.video.replace('review.mp4', 'montage.json'))).toEqual(value);
    expect(start).toHaveBeenCalledWith('review', expect.any(String), project, [
      expect.objectContaining({ tool: 'build_review', args: ['--spec', join(project, spec), '--output', join(project, result.video)] })
    ]);
    expect(montage.export(project, value).video).not.toBe(result.video);
  });

  it('блокирует применение устаревшего реестра и изменённого выбранного комплекта', () => {
    const value = draft();
    const manifest = read('assets/shots/M01/manifest.json');
    json('assets/shots/M01/manifest.json', { ...(manifest as object), note: 'Изменено после открытия' });
    expect(() => montage.apply(project, value)).toThrow(/Манифесты/);
    const fresh = draft();
    file('plan/scenes.json', `${readFileSync(join(project, 'plan/scenes.json'), 'utf8')}\n`);
    expect(() => montage.apply(project, fresh)).toThrow(/Реестр/);
    expect(start).not.toHaveBeenCalled();
  });

  it('применяет замороженный draft и допускает изменение невыбранного комплекта', () => {
    const value = draft();
    json('assets/shots/M03/manifest.json', { accepted_edit: { frames: 60 } });
    const result = montage.apply(project, value);
    expect(result).toBe(job);
    const call = start.mock.calls[0];
    const spec = call[3][0].args[1];
    expect(call[0]).toBe('tool');
    expect(call[3][0].tool).toBe('apply_montage');
    expect(spec).toMatch(/^plan\/batches\/apply-manual-[a-f0-9-]+\/montage\.json$/);
    value.clips[0].source_end_frame_exclusive = 1;
    expect((read(spec) as MontageDraft).clips[0].source_end_frame_exclusive).toBe(30);
  });
});
