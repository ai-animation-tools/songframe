/** Речевые планы: строки песни в окне плана и точный WAV липсинка в пакете (режет штатный cut_speech). */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { PackageSpeech, SpeechLine, SpeechPlan } from '@shared/types';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);
const finite = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value);

function readJson(path: string): unknown {
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Строки разметки в окне плана и предложенный срез. Срез начинается с начала окна: в монтаже клип плана тоже начинается
 * с этой точки песни, и губы совпадают со звуком без сдвига. Длина — не меньше окна, длительности запроса и минимума звукового входа.
 */
export function speechPlan(
  project: string,
  shot: string,
  limits: { requestSeconds?: number | null; lipSync?: { min: number; max: number } | null } = {}
): SpeechPlan {
  const scenes = readJson(join(project, 'plan/scenes.json'));
  if (!record(scenes) || !Array.isArray(scenes.scenes) || !finite(scenes.fps)) throw new Error('Не удалось прочитать реестр сцен.');
  const scene = scenes.scenes.find((item) => record(item) && item.id === shot);
  if (!record(scene) || !finite(scene.start_frame) || !finite(scene.end_frame_exclusive)) throw new Error(`${shot}: план отсутствует в реестре сцен.`);
  const window = { start: scene.start_frame / scenes.fps, end: scene.end_frame_exclusive / scenes.fps };
  const timing = readJson(join(project, 'plan/audio/timing.json'));
  let text: string[] = [];
  try {
    text = readFileSync(join(project, 'source/text.md'), 'utf8').split(/\r?\n/);
  } catch {
    text = [];
  }
  const lines: SpeechLine[] = (record(timing) && Array.isArray(timing.lines) ? timing.lines : [])
    .filter((line): line is Record<string, unknown> => record(line) && finite(line.start) && finite(line.end))
    .filter((line) => (line.end as number) > window.start && (line.start as number) < window.end)
    .map((line) => {
      const number = line.source_line;
      return {
        text: Number.isInteger(number) && (number as number) > 0 && (number as number) <= text.length ? text[(number as number) - 1].trim() : null,
        start: line.start as number,
        end: line.end as number
      };
    });
  const length = Math.max(window.end - window.start, limits.requestSeconds ?? 0, limits.lipSync?.min ?? 0);
  const round = (value: number): number => Math.round(value * 1000) / 1000;
  const proposed = { start: round(window.start), end: round(window.start + length) };
  return { shot, window, lines, proposed, lipSync: limits.lipSync ?? null };
}

/** Подготовленный срез пакета; без рецепта или файла WAV считается, что среза нет. */
export function readPackageSpeech(packageDir: string): PackageSpeech | null {
  const recipePath = join(packageDir, 'audio', 'audio-recipe.json');
  const recipe = readJson(recipePath);
  if (!record(recipe) || !Array.isArray(recipe.source_interval_seconds) || !record(recipe.output)) return null;
  const [start, end] = recipe.source_interval_seconds;
  const name = recipe.output.path;
  if (!finite(start) || !finite(end) || typeof name !== 'string' || name.includes('/') || name.includes('\\')) return null;
  const path = join(packageDir, 'audio', name);
  if (!existsSync(path)) return null;
  const lines: SpeechLine[] = Array.isArray(recipe.timing_lines)
    ? recipe.timing_lines
        .filter((line): line is Record<string, unknown> => record(line) && finite(line.start) && finite(line.end))
        .map((line) => ({ text: typeof line.text === 'string' ? line.text : null, start: line.start as number, end: line.end as number }))
    : [];
  return { path, recipe: recipePath, start, end, lines };
}
