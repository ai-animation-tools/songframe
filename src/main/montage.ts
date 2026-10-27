/** Хранение ручного монтажа и запуск локальных инструментов; @link ../../docs/montage.md. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { isAbsolute, join, relative, resolve, win32 } from 'node:path';
import { secondsToFrames } from '@shared/video';
import { selectLyricTimings } from '@shared/lyrics';
import type { MontageDraft, MontageExport, MontageSaved, MontageView } from '@shared/montage';
import type { JobInfo } from '@shared/types';
import type { Jobs } from './jobs';
import { readLocalJson, writeLocalJson } from './local-files';
import { readScenarioRegistry } from './scenario-status';
import { viewTiming } from './timing';

type Json = Record<string, unknown>;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SHA256 = /^[0-9a-f]{64}$/i;
const SHOT = /^M\d{2}(?:\.\d+)?$/;

function object(value: unknown): value is Json {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function frame(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;
}

function hash(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('hex');
}

/** В JSON сохраняются только переносимые пути. Оба вида абсолютных путей отклоняются на любой ОС. */
function projectPath(project: string, value: unknown, requireFile = true): string {
  if (typeof value !== 'string' || !value || value.includes('\\') || isAbsolute(value) || win32.isAbsolute(value))
    throw new Error('Укажите относительный путь от корня проекта через /.');
  const parts = value.split('/');
  if (parts.some((part) => !part || part === '.' || part === '..')) throw new Error(`Недопустимый путь проекта: ${value}`);
  const full = resolve(project, value);
  if (requireFile && (!existsSync(full) || !statSync(full).isFile())) throw new Error(`Файл проекта не найден: ${value}`);
  return full;
}

function portable(project: string, path: string): string {
  return relative(project, path).split('\\').join('/');
}

function readObject(path: string, label: string): Json {
  try {
    const value = readLocalJson<unknown>(path);
    if (!object(value)) throw new Error('Некорректная структура данных.');
    return value;
  } catch (error) {
    throw new Error(`Не удалось прочитать ${label}. Файл сохранён; исправьте его или перенесите в резервную папку.`, { cause: error });
  }
}

function idPath(project: string, id: string): string {
  if (!UUID.test(id)) throw new Error('Некорректный идентификатор монтажного черновика.');
  return join(project, 'plan', 'montage', `${id}.json`);
}

function originalFrames(value: unknown): number | null {
  if (!object(value)) return null;
  const duration = Number(value.duration);
  if (Number.isFinite(duration) && duration > 0) return secondsToFrames(duration);
  const rate = typeof value.r_frame_rate === 'string' ? value.r_frame_rate.split('/').map(Number) : [];
  const fps = rate.length === 1 ? rate[0] : rate.length === 2 && rate[1] > 0 ? rate[0] / rate[1] : NaN;
  const frames = Number(value.nb_frames);
  return Number.isFinite(fps) && fps > 0 && Number.isFinite(frames) && frames > 0 ? secondsToFrames(frames / fps) : null;
}

function message(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Каталог читает небольшие JSON, не запускает Python/FFmpeg и не перечитывает байты видеороликов. */
export class Montage {
  constructor(private readonly jobs: Jobs) {}

  view(project: string): MontageView {
    const view: MontageView = {
      scenarioStatus: 'missing',
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
      problems: []
    };
    const scenario = readScenarioRegistry(project);
    view.scenarioStatus = scenario.status;
    if (scenario.status === 'missing') {
      view.problems.push('Сначала нужен сценарий. Создайте его на странице «Сценарий».');
      return view;
    }
    if (scenario.status === 'empty') {
      view.problems.push('В сценарии пока нет сцен. Добавьте их на странице «Сценарий».');
      return view;
    }
    if (scenario.status === 'invalid' || !scenario.registry) {
      view.problems.push('Не удалось прочитать сценарий. Проверьте и исправьте его на странице «Сценарий».');
      return view;
    }
    // Общая проверка завершается целиком до музыки и материалов, исключая частичный каталог сцен.
    const registry = scenario.registry;
    const sequences = new Map(
      (Array.isArray(registry.sequences) ? registry.sequences : []).filter((sequence) => object(sequence)).map((sequence) => [sequence.id, sequence.title])
    );
    view.scenesSha256 = scenario.sha256;
    view.scenes = registry.scenes.map((scene) => ({
      id: scene.id,
      title: String(scene.title ?? sequences.get(scene.sequence) ?? scene.original ?? scene.id),
      startFrame: scene.start_frame,
      endFrame: scene.end_frame_exclusive
    }));
    const timing = viewTiming(project);
    view.trackPath = timing.trackPath ? portable(project, timing.trackPath) : null;
    view.trackSha256 = timing.trackSha256;
    view.duration = timing.duration;
    view.problems.push(...timing.problems);
    if (!timing.timing) view.lyricProblem = 'Разметка строк песни недоступна. Создайте её на странице «Тайминги».';
    else if (timing.timing.sha256 && timing.trackSha256 && timing.timing.sha256 !== timing.trackSha256)
      view.lyricProblem = 'Разметка относится к другому треку. Проверьте её на странице «Тайминги».';
    else {
      const selected = selectLyricTimings(timing.timing.lines, timing.lyrics);
      const lyrics = new Map(timing.lyrics.map((line) => [line.number, line.text]));
      if (
        selected.invalidIds.length ||
        selected.lines.some((line) => !Number.isFinite(line.start) || !Number.isFinite(line.end) || line.start < 0 || line.end <= line.start)
      )
        view.lyricProblem = 'Разметка не соответствует тексту или содержит неверные границы. Проверьте её на странице «Тайминги».';
      else {
        // Строки и склейки используют одну сетку 30 FPS и абсолютную ось исходного трека.
        view.lyricLines = selected.lines.map((line) => ({
          id: line.id,
          text: lyrics.get(line.source_line) ?? '',
          startFrame: secondsToFrames(line.start),
          endFrame: secondsToFrames(line.end)
        }));
        if (!view.lyricLines.length) view.lyricProblem = 'В разметке пока нет строк песни. Добавьте их на странице «Тайминги».';
      }
    }
    const addSource = (scene: string, title: string, label: string, dir: string, descriptor: unknown, frames: number | null, original: boolean): void => {
      if (!object(descriptor) || typeof descriptor.path !== 'string') return;
      const base = descriptor.root === 'source' ? join(project, 'source') : dir;
      const path = portable(project, join(base, descriptor.path));
      try {
        projectPath(project, path);
        if (!view.sources.some((source) => source.scene === scene && source.path === path))
          view.sources.push({ id: `${scene}:${path}`, scene, title, label, path, kind: 'video', frames, original });
      } catch (error) {
        view.problems.push(`${scene}: ${message(error)}`);
      }
    };
    for (const scene of view.scenes) {
      const dir = join(project, 'assets', 'shots', scene.id);
      const manifestPath = join(dir, 'manifest.json');
      if (!existsSync(manifestPath)) continue;
      // Ошибка отдельного комплекта не меняет доступность самого сценария.
      try {
        view.manifestSha256[scene.id] = hash(manifestPath);
        const manifest = readObject(manifestPath, 'описание материалов сцены');
        const generation = object(manifest.generation) ? manifest.generation : {};
        const edit = object(manifest.accepted_edit) ? manifest.accepted_edit : {};
        addSource(scene.id, scene.title, 'Оригинал генерации', dir, generation.original, originalFrames(generation.original_media), true);
        addSource(scene.id, scene.title, 'Принятый монтаж', dir, edit.video, frame(edit.frames) && edit.frames > 0 ? edit.frames : null, false);
      } catch (error) {
        view.problems.push(`${scene.id}: ${message(error)}`);
      }
    }

    // Не используем readPackage: его токены решений хешируют полные платные оригиналы на каждом чтении.
    for (const base of ['plan/batches', 'plan/awaiting']) {
      const folder = join(project, base);
      if (!existsSync(folder)) continue;
      for (const entry of readdirSync(folder, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const dir = join(folder, entry.name);
        if (!existsSync(join(dir, 'workflow.json'))) continue;
        try {
          const workflow = readObject(join(dir, 'workflow.json'), 'состояние рабочего пакета');
          const scene = view.scenes.find((item) => item.id === workflow.shot);
          if (!scene || typeof workflow.request_dir !== 'string') continue;
          const requestDir = projectPath(project, portable(project, join(dir, workflow.request_dir)), false);
          const request = readObject(join(requestDir, 'request.json'), 'запрос рабочего пакета');
          if (request.kind === 'image') continue;
          const attemptPath = join(requestDir, 'attempt.json');
          const attempt = existsSync(attemptPath) ? readObject(attemptPath, 'результат попытки генерации') : {};
          const downloads = Array.isArray(attempt.downloads)
            ? attempt.downloads
                .filter((item): item is Json => object(item))
                .map((item) => item.path)
                .filter((path): path is string => typeof path === 'string' && /\.mp4$/i.test(path))
            : [];
          downloads.push(...readdirSync(requestDir).filter((name) => /^original(?:-\d+)?\.mp4$/i.test(name)));
          for (const name of new Set(downloads)) addSource(scene.id, scene.title, `Рабочий оригинал: ${entry.name}`, requestDir, { path: name }, null, true);
        } catch (error) {
          view.problems.push(`${entry.name}: ${message(error)}`);
        }
      }
    }
    for (const scene of view.scenes) {
      if (view.sources.some((source) => source.scene === scene.id)) continue;
      const path = `plan/animatic/cards/${scene.id}.png`;
      if (existsSync(join(project, path)))
        view.sources.push({
          id: `${scene.id}:${path}`,
          scene: scene.id,
          title: scene.title,
          label: 'Карточка сцены',
          path,
          kind: 'card',
          frames: null,
          original: false
        });
      else view.problems.push(`${scene.id}: нет видео и карточки ${path}.`);
    }
    const folder = join(project, 'plan', 'montage');
    if (existsSync(folder)) {
      for (const file of readdirSync(folder)) {
        if (!file.endsWith('.json') || !UUID.test(file.slice(0, -5))) continue;
        try {
          const draft = this.load(project, file.slice(0, -5));
          view.saved.push({ id: file.slice(0, -5), name: draft.name, updatedAt: statSync(join(folder, file)).mtime.toISOString() });
        } catch (error) {
          view.problems.push(`Черновик ${file}: ${message(error)}`);
        }
      }
      view.saved.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
    }
    return view;
  }

  /** Незавершённый черновик допустим: проверка совпадения длин выполняется перед экспортом и применением. */
  private validate(project: string, value: unknown, complete: boolean, view?: MontageView, checkFiles = true): asserts value is MontageDraft {
    if (!object(value) || value.schema_version !== 1 || typeof value.name !== 'string' || !object(value.audio) || !Array.isArray(value.clips))
      throw new Error('Некорректная структура монтажного черновика.');
    if (typeof value.base_scenes_sha256 !== 'string' || !SHA256.test(value.base_scenes_sha256) || !object(value.base_manifest_sha256))
      throw new Error('Черновик не содержит снимок реестра и манифестов.');
    for (const [scene, sha] of Object.entries(value.base_manifest_sha256)) {
      if (!SHOT.test(scene) || typeof sha !== 'string' || !SHA256.test(sha)) throw new Error(`Некорректный снимок манифеста: ${scene}`);
    }
    projectPath(project, value.audio.path, checkFiles);
    if (!frame(value.audio.start_frame) || !frame(value.audio.end_frame_exclusive) || value.audio.end_frame_exclusive < value.audio.start_frame)
      throw new Error('Некорректные кадровые границы музыки.');
    const scenes = new Set<string>();
    const ids = new Set<string>();
    let total = 0;
    for (const clip of value.clips) {
      if (
        !object(clip) ||
        typeof clip.id !== 'string' ||
        !clip.id ||
        ids.has(clip.id) ||
        typeof clip.scene !== 'string' ||
        !SHOT.test(clip.scene) ||
        scenes.has(clip.scene)
      )
        throw new Error('Коды сцен и идентификаторы фрагментов должны быть неповторяющимися.');
      ids.add(clip.id);
      scenes.add(clip.scene);
      if (clip.kind !== 'video' && clip.kind !== 'card') throw new Error(`${clip.scene}: неизвестный вид материала.`);
      projectPath(project, clip.path, checkFiles);
      if (!frame(clip.source_start_frame) || !frame(clip.source_end_frame_exclusive) || clip.source_end_frame_exclusive <= clip.source_start_frame)
        throw new Error(`${clip.scene}: задайте целые кадровые границы непустого участка.`);
      if (clip.source_frames !== null && (!frame(clip.source_frames) || clip.source_frames === 0))
        throw new Error(`${clip.scene}: некорректная длина исходника.`);
      if (clip.kind === 'card' && clip.source_start_frame !== 0) throw new Error(`${clip.scene}: карточка должна начинаться с кадра 0.`);
      const source = view?.sources.find((item) => item.path === clip.path && item.scene === clip.scene && item.kind === clip.kind);
      let limit = source?.frames ?? clip.source_frames;
      // При сохранении проверяем известную длину даже при source_frames=null. Изменённый комплект
      // не подменяет метаданные старого черновика: его всё ещё можно открыть и сохранить.
      if (checkFiles && !view && clip.kind === 'video') {
        const dir = join(project, 'assets', 'shots', clip.scene);
        const path = join(dir, 'manifest.json');
        if (existsSync(path) && value.base_manifest_sha256[clip.scene] === hash(path)) {
          const manifest = readObject(path, 'описание материалов сцены');
          const generation = object(manifest.generation) ? manifest.generation : {};
          const edit = object(manifest.accepted_edit) ? manifest.accepted_edit : {};
          for (const [descriptor, frames] of [
            [generation.original, originalFrames(generation.original_media)],
            [edit.video, frame(edit.frames) ? edit.frames : null]
          ] as const) {
            if (object(descriptor) && typeof descriptor.path === 'string') {
              const base = descriptor.root === 'source' ? join(project, 'source') : dir;
              if (portable(project, join(base, descriptor.path)) === clip.path && frames !== null) limit = frames;
            }
          }
        }
      }
      if (clip.kind === 'video' && typeof limit === 'number' && clip.source_end_frame_exclusive > limit)
        throw new Error(`${clip.scene}: выбранный участок выходит за пределы исходника.`);
      if (complete && !view?.scenes.some((scene) => scene.id === clip.scene)) throw new Error(`В реестре больше нет сцены ${clip.scene}.`);
      total += clip.source_end_frame_exclusive - clip.source_start_frame;
      if (!Number.isSafeInteger(total)) throw new Error('Суммарная длина монтажа слишком велика.');
    }
    if (complete) {
      if (!value.clips.length || total !== value.audio.end_frame_exclusive - value.audio.start_frame)
        throw new Error('Длина видеодорожки должна совпадать с выбранным участком музыки.');
      if (value.audio.path !== view?.trackPath) throw new Error('Выбранная музыка не совпадает с текущим треком проекта.');
      if (typeof view?.duration === 'number' && Number.isFinite(view.duration) && value.audio.end_frame_exclusive > secondsToFrames(view.duration))
        throw new Error('Выбранный участок выходит за пределы музыки.');
    }
  }

  load(project: string, id: string): MontageDraft {
    const value: unknown = readObject(idPath(project, id), 'монтажный черновик');
    this.validate(project, value, false);
    return value;
  }

  save(project: string, draft: MontageDraft, id: string = randomUUID()): MontageSaved {
    const path = idPath(project, id);
    this.validate(project, draft, false);
    // Проверяем структуру прежнего JSON, но его устаревшие пути не должны мешать
    // сохранить исправленный черновик после переноса или повторного выбора исходника.
    if (existsSync(path)) this.validate(project, readObject(path, 'монтажный черновик'), false, undefined, false);
    writeLocalJson(path, draft);
    return { id, name: draft.name, updatedAt: statSync(path).mtime.toISOString() };
  }

  export(project: string, draft: MontageDraft): MontageExport {
    const view = this.view(project);
    this.validate(project, draft, true, view);
    const folder = `plan/batches/review-manual-${randomUUID()}`;
    const spec = `${folder}/review-spec.json`;
    const video = `${folder}/review.mp4`;
    writeLocalJson(join(project, folder, 'montage.json'), draft);
    writeLocalJson(join(project, spec), {
      schema_version: 1,
      shots: draft.clips.map((clip) => ({
        scene: clip.scene,
        path: clip.path,
        kind: clip.kind,
        source_start_frame: clip.source_start_frame,
        source_end_frame_exclusive: clip.source_end_frame_exclusive
      })),
      audio: { path: draft.audio.path, start_frame: draft.audio.start_frame }
    });
    const job = this.jobs.start('review', `Ручная проба: ${draft.name}`, project, [
      // CLI читает эти два аргумента от cwd комплекса, поэтому разрешаем их при запуске.
      // В самом рецепте и сохранённом черновике пути остаются относительно проекта.
      { tool: 'build_review', args: ['--spec', join(project, spec), '--output', join(project, video)], label: 'Сборка ручной пробы' }
    ]);
    return { job, video };
  }

  apply(project: string, draft: MontageDraft): JobInfo {
    const view = this.view(project);
    this.validate(project, draft, true, view);
    if (draft.base_scenes_sha256 !== view.scenesSha256) throw new Error('Реестр сцен изменился: заново откройте материалы перед применением.');
    if (draft.clips.some((clip) => !view.manifestSha256[clip.scene] || draft.base_manifest_sha256[clip.scene] !== view.manifestSha256[clip.scene]))
      throw new Error('Манифесты комплектов изменились: заново откройте материалы перед применением.');
    const spec = `plan/batches/apply-manual-${randomUUID()}/montage.json`;
    writeLocalJson(join(project, spec), draft);
    return this.jobs.start('tool', `Применение монтажа: ${draft.name}`, project, [
      { tool: 'apply_montage', args: ['--spec', spec], label: 'Применение ручного монтажа к сценам' }
    ]);
  }
}
