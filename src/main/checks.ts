/**
 * Панель проверок: инструменты комплекса запускаются заданиями с журналом, проба стыков собирается в plan/batches,
 * а блок generation и название проекта правятся в plan/project.json без потери прочих полей.
 */

import { existsSync, readdirSync, readFileSync, rmdirSync, statSync, unlinkSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import type {
  CheckId,
  CheckInfo,
  CheckOptions,
  GenerationSettings,
  ImageGenerationSettings,
  JobInfo,
  ProjectSettings,
  ReviewInfo,
  ReviewOptions,
  VideoGenerationSettings
} from '@shared/types';
import { DURATION_RULES } from '@shared/types';
import type { Jobs, Step } from './jobs';
import { writeLocalJson } from './local-files';
import { checkedBuiltOutput } from './built-output-path';

function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

export const CHECKS: CheckInfo[] = [
  {
    id: 'lint',
    label: 'Данные сцен',
    description: 'Проверить формат реестра сцен, комплектов и рабочих пакетов. Постановка, исходники и результаты должны храниться в отведённых им файлах.',
    tool: 'lint_registry',
    needsScenes: true
  },
  {
    id: 'views',
    label: 'Карточки и списки',
    description: 'Проверить, что монтажный список, раскадровка, карточки и список принятых материалов соответствуют реестру сцен.',
    tool: 'update_scene_views',
    needsScenes: true
  },
  {
    id: 'assets',
    label: 'Комплекты сцен',
    description: 'Проверить сохранность файлов принятых сцен и совпадение длительности монтажа с данными о приёмке.',
    tool: 'check_assets',
    needsScenes: true
  },
  {
    id: 'workspace',
    label: 'Порядок в папке проекта',
    description: 'Найти лишние рабочие пакеты, карточки и пустые папки, оставшиеся после приёмки сцен.',
    tool: 'check_workspace',
    needsScenes: true
  },
  {
    id: 'status',
    label: 'Статусы планов',
    description: 'Показать готовые планы, текущие попытки и очередь согласования. Помогает выбрать следующий план для работы.',
    tool: 'shot_status',
    needsScenes: true
  }
];

const SHOT_ID = /^M\d{2}(?:\.\d+)?$/;

export function checkStep(id: CheckId, options: CheckOptions = {}): Step {
  const info = CHECKS.find((c) => c.id === id);
  if (!info) throw new Error(`Неизвестная проверка: ${id}`);
  const args: string[] = [];
  if (id === 'lint' && options.strict) args.push('--strict');
  if (id === 'views') args.push('--check');
  if (id === 'status' && options.next) args.push('--next');
  return { tool: info.tool, args, label: info.label };
}

function stamp(): string {
  const d = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}`;
}

/** Папка пробы: build_review принимает выход только в plan/batches, существующий результат не перезаписывает. */
export function reviewOutput(project: string, shots: string[], now = stamp()): string {
  const name = shots.length <= 3 ? shots.join('-') : `${shots[0]}-${shots[shots.length - 1]}`;
  return join(project, 'plan', 'batches', `review-${name}-${now}`, 'review.mp4');
}

export class Checks {
  private readonly reviewJobs = new Map<string, string>();

  constructor(private readonly jobs: Jobs) {}

  run(project: string, id: CheckId, options: CheckOptions = {}): JobInfo {
    const step = checkStep(id, options);
    return this.jobs.start('check', `Проверка: ${step.label}`, project, [step]);
  }

  /** Все проверки одним заданием: неудача одной не отменяет остальные, но делает задание неудачным. */
  runAll(project: string, options: CheckOptions = {}): JobInfo {
    const steps = CHECKS.map((c) => ({ ...checkStep(c.id, options), stop: false }));
    return this.jobs.start('check', 'Все проверки', project, steps);
  }

  updateViews(project: string): JobInfo {
    return this.jobs.start('tool', 'Обновление карточек и списков', project, [
      { tool: 'update_scene_views', args: [], label: 'Обновление карточек и списков' }
    ]);
  }

  buildReview(project: string, options: ReviewOptions): JobInfo {
    const shots = options.shots.map((s) => s.trim()).filter(Boolean);
    if (!shots.length) throw new Error('Выберите хотя бы один план для пробы.');
    const bad = shots.filter((s) => !SHOT_ID.test(s));
    if (bad.length) throw new Error(`Коды планов вида M05 или M05.1: ${bad.join(', ')}`);
    const output = reviewOutput(project, shots);
    const args = ['--shots', ...shots, '--output', output, ...(options.planOnly ? ['--plan-only'] : [])];
    const job = this.jobs.start('review', `Проба ${shots.join(' ')}${options.planOnly ? ' (только рецепт)' : ''}`, project, [
      { tool: 'build_review', args, label: options.planOnly ? 'Подготовка рецепта пробы' : 'Сборка пробы стыков' }
    ]);
    this.reviewJobs.set(resolve(output), job.id);
    return job;
  }

  /** Проба может лежать рядом с рабочими материалами: удаляем только её MP4 и одноимённый рецепт. */
  removeReview(project: string, path: string): void {
    const video = checkedBuiltOutput(project, path, 'file');
    if (this.jobs.get(this.reviewJobs.get(video) ?? '')?.status === 'running') throw new Error('Проба ещё собирается. Дождитесь завершения задания.');
    const review = listReviews(project).find((item) => resolve(item.video) === video);
    if (!review) throw new Error('Собранная проба не найдена. Обновите список.');
    const manifest = checkedBuiltOutput(project, review.manifest, 'file');
    unlinkSync(video);
    unlinkSync(manifest);
    // Пустой каталог пробы мешает check_workspace; папки с соседними результатами и рабочими материалами сохраняем.
    const directory = dirname(video);
    if (readdirSync(directory).length === 0) rmdirSync(directory);
  }
}

/** Пробы внутри plan/batches: MP4 с одноимённым JSON рецепта build_review (есть video_sha256 и total_frames). */
export function listReviews(project: string): ReviewInfo[] {
  const folder = join(project, 'plan', 'batches');
  if (!existsSync(folder)) return [];
  const result: ReviewInfo[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = join(folder, entry.name);
    for (const file of readdirSync(dir)) {
      if (!file.endsWith('.json')) continue;
      const video = join(dir, file.slice(0, -5) + '.mp4');
      if (!existsSync(video)) continue;
      const data = readJson<{ shots?: { id?: string }[]; total_frames?: number; video_sha256?: string }>(join(dir, file));
      if (!data || typeof data.video_sha256 !== 'string' || !Array.isArray(data.shots)) continue;
      result.push({
        dir,
        video,
        manifest: join(dir, file),
        shots: data.shots.map((s) => String(s.id ?? '')),
        totalFrames: Number(data.total_frames ?? 0),
        createdAt: statSync(video).mtime.toISOString()
      });
    }
  }
  return result.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
}

const PROJECT_FILE = join('plan', 'project.json');

function readProjectFile(project: string): Record<string, unknown> {
  const path = join(project, PROJECT_FILE);
  let data: unknown;
  try {
    data = JSON.parse(readFileSync(path, 'utf-8'));
  } catch (error) {
    throw new Error(`Не удалось прочитать ${PROJECT_FILE}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  if (typeof data !== 'object' || data === null || Array.isArray(data)) throw new Error(`${PROJECT_FILE} должен быть объектом.`);
  return data as Record<string, unknown>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Настройки читаются только из video/image; поля другого формата не подтверждают выбор медиапровайдера. */
function readGeneration(data: Record<string, unknown>): GenerationSettings | null {
  const block = data.generation;
  if (!isRecord(block)) return null;
  return {
    ...block,
    video: isRecord(block.video) ? ({ ...block.video } as unknown as VideoGenerationSettings) : null,
    image: isRecord(block.image) ? ({ ...block.image } as unknown as ImageGenerationSettings) : null
  };
}

export function readProjectSettings(project: string): ProjectSettings {
  const data = readProjectFile(project);
  return {
    name: typeof data.name === 'string' ? data.name : '',
    animaticVideo: typeof data.animatic_video === 'string' ? data.animatic_video : '',
    generation: readGeneration(data)
  };
}

/** Структурные правила совпадают с scene_registry; готовность провайдера проверяется отдельно для каждого медиа. */
export function validateProjectSettings(settings: ProjectSettings): string[] {
  const problems: string[] = [];
  if (!settings.name.trim()) problems.push('Название проекта не может быть пустым.');
  if (!/^[\w.-]+\.mp4$/.test(settings.animaticVideo) || settings.animaticVideo.startsWith('.'))
    problems.push('Имя MP4 аниматика: буквы, цифры, точки и дефисы, без пути к папке, с расширением .mp4.');
  const g = settings.generation;
  if (!g) return problems;
  for (const kind of ['video', 'image'] as const) {
    const block = g[kind];
    if (block === null || block === undefined) continue;
    const prefix = `generation.${kind}: `;
    if (!isRecord(block)) {
      problems.push(`${prefix}ожидается объект настроек.`);
      continue;
    }
    const required = kind === 'video' ? ['provider', 'resolution', 'aspect_ratio', 'duration_rule'] : ['provider'];
    for (const field of required) {
      if (typeof block[field] !== 'string' || !(block[field] as string).trim()) problems.push(`${prefix}не заполнено поле ${field}.`);
    }
    // IPC сохраняет ключи со значением undefined: для необязательных полей это
    // явное удаление настройки, которое mergeSettings сохраняет до записи JSON.
    for (const field of ['resolution', 'aspect_ratio', 'model']) {
      if (block[field] !== undefined && (typeof block[field] !== 'string' || !(block[field] as string).trim()) && !required.includes(field))
        problems.push(`${prefix}${field} должен быть непустой строкой.`);
    }
    // auto сохраняется для обоих медиа; поддержку конкретной моделью проверяет подготовка запроса.
    if (
      block.aspect_ratio !== undefined &&
      (typeof block.aspect_ratio !== 'string' || (!/^\d+:\d+$/.test(block.aspect_ratio) && block.aspect_ratio !== 'auto'))
    )
      problems.push(`${prefix}пропорции записываются как 16:9 или auto.`);
    if ((kind === 'video' || block.watermark !== undefined) && typeof block.watermark !== 'boolean')
      problems.push(`${prefix}watermark должен быть логическим значением.`);
    if (kind === 'video' && !DURATION_RULES.includes(block.duration_rule as VideoGenerationSettings['duration_rule']))
      problems.push(`${prefix}правило длительности должно быть одним из: ${DURATION_RULES.join(', ')}.`);
    // Имя провайдера без маркера не подтверждает явный выбор пользователя.
    if (block.provider_selected !== undefined && typeof block.provider_selected !== 'boolean')
      problems.push(`${prefix}provider_selected должен быть логическим значением.`);
    if (block.options !== undefined && !isRecord(block.options)) problems.push(`${prefix}options должен быть объектом.`);
    if (kind === 'image' && block.outputs !== undefined && (!Number.isInteger(block.outputs) || Number(block.outputs) < 1))
      problems.push(`${prefix}outputs должен быть положительным целым числом.`);
  }
  return problems;
}

/** Сохраняем расширения провайдеров, включая вложенные options/backend, при правке известных полей. */
function mergeSettings(previous: Record<string, unknown>, current: Record<string, unknown>): Record<string, unknown> {
  const result = { ...previous };
  for (const [key, value] of Object.entries(current)) {
    result[key] = isRecord(value) && isRecord(result[key]) ? mergeSettings(result[key], value) : value;
  }
  return result;
}

export function writeProjectSettings(project: string, settings: ProjectSettings): ProjectSettings {
  const problems = validateProjectSettings(settings);
  if (problems.length) throw new Error(problems.join(' '));
  const data = readProjectFile(project);
  const previous = readGeneration(data);
  let generation: unknown = settings.generation ? mergeSettings(previous ?? {}, settings.generation) : null;
  // Повреждённый непоказанный блок не исчезает от сохранения имени/MP4; заменить его можно явным заполнением формы.
  if (isRecord(generation) && isRecord(data.generation)) {
    for (const kind of ['video', 'image'] as const)
      if (settings.generation?.[kind] === null && data.generation[kind] != null && !isRecord(data.generation[kind])) generation[kind] = data.generation[kind];
  } else if (!generation && data.generation != null && !isRecord(data.generation)) generation = data.generation;
  const next: Record<string, unknown> = {
    ...data,
    name: settings.name.trim(),
    animatic_video: settings.animaticVideo,
    generation
  };
  if (typeof next.schema_version !== 'number') next.schema_version = 1;
  writeLocalJson(join(project, PROJECT_FILE), next);
  return readProjectSettings(project);
}
