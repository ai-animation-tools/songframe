/**
 * Эффекты поверх принятого плана (window.api.effects, Go — internal/shoteffects): дождь, свет,
 * зерно. Платный оригинал и принятое видео плана эффект не меняет: ролик с эффектом и рецепт
 * лежат в assets/effects/Mxx/, монтаж берёт его, пока он свеж. Наклон дождя без своего значения
 * Go считает из ветра плана и направления камеры точки съёмки.
 */
import type { EffectParamSpec, JobInfo } from './types';

/** Ветер дождя плана: куда дует (градусы против часовой от востока, как камера) и сила. */
export interface EffectWind {
  direction: number;
  strength: number;
}

/** Эффект цепочки, как его задаёт человек: заданные значения (остальные — по умолчанию) и ветер. */
export interface EffectStep {
  effect: string;
  given: Record<string, number>;
  wind?: EffectWind | null;
}

/** Шаг применённого рецепта: версия эффекта и полные значения параметров, с которыми сделан ролик. */
export interface AppliedEffectStep extends EffectStep {
  version: number;
  params: Record<string, number>;
}

/**
 * Имена параметров источника и луча, которые ставятся мышью на кадре: координаты источника —
 * доли ширины и высоты кадра (за краем — меньше 0 или больше 1), дальность — доля диагонали,
 * направление — градусы на экране против часовой от направления вправо, ширина — полный угол.
 */
export interface EffectBeam {
  x: string;
  y: string;
  radius: string;
  direction: string;
  cone: string;
}

/**
 * Эффект из реестра Go; windAngle — параметр наклона, который считается из ветра ("" — нет);
 * planTime — параметры-моменты плана: рецепт хранит долю длины, поля показывают секунды;
 * beam — источник и луч на кадре (null — у эффекта нет источника).
 */
export interface EffectKind {
  id: string;
  title: string;
  /** Когда и зачем применять эффект и что получится. */
  hint: string;
  params: EffectParamSpec[];
  windAngle: string;
  planTime: string[];
  beam: EffectBeam | null;
}

/** Строка песни на шкале плана: секунды от начала плана (может начинаться до него). */
export interface EffectLine {
  text: string;
  start: number;
  end: number;
}

/**
 * Принятый план страницы эффектов. applied — у плана есть рецепт; output — ролик с эффектом;
 * stale — почему он не идёт в монтаж ("" — свеж); problem — почему эффект недоступен (комплект);
 * camera — у плана есть направление камеры (без него ветер не применить); jobId — идущий рендер.
 */
export interface EffectShot {
  shot: string;
  title: string;
  start: number;
  end: number;
  fps: number;
  frames: number;
  source: string;
  applied: boolean;
  steps: AppliedEffectStep[];
  output: string;
  version: string;
  stale: string;
  problem: string;
  /** Речевой план (липсинк): отметка «Речь» на карточке. */
  lipsync: boolean;
  camera: boolean;
  /** Направление камеры первого кадра (градусы против часовой от востока), если camera. */
  heading: number;
  jobId: string;
  /** Изображение карточки: первая опора принятого комплекта; "" — опор нет, на карточке заглушка. */
  frame: string;
  /** Строки песни в окне плана для шкалы моментов эффекта. */
  lines: EffectLine[];
  /** Почему строк нет (разметки нет, трек сменился); null — строки есть или их в окне нет. */
  lyricProblem: string | null;
}

export interface EffectsView {
  kinds: EffectKind[];
  shots: EffectShot[];
}

export interface EffectsApi {
  /** Эффекты реестра и принятые планы по порядку сценария. Только чтение. */
  view(project: string): Promise<EffectsView>;
  /** Кадр frame принятого видео с цепочкой steps: JPEG data: URL шириной width. Ничего не пишет. */
  preview(project: string, shot: string, steps: EffectStep[], frame: number, width: number): Promise<string>;
  /** Задание рендера ролика с эффектом; ошибки рецепта — сразу, до задания. */
  render(project: string, shot: string, steps: EffectStep[]): Promise<JobInfo>;
  /** Убирает эффект: монтаж снова берёт принятое видео. */
  remove(project: string, shot: string): Promise<EffectsView>;
}

/** Шаги для правки: только то, что задал человек (полные значения считает Go заново). */
export function editableSteps(steps: AppliedEffectStep[]): EffectStep[] {
  return steps.map(({ effect, given, wind }) => ({ effect, given: { ...given }, ...(wind ? { wind: { ...wind } } : {}) }));
}

/** Значение параметра в черновике: заданное или по умолчанию. */
export function stepValue(step: EffectStep, spec: EffectParamSpec): number {
  return step.given[spec.name] ?? spec.default;
}

/**
 * Новое значение параметра: равное значению по умолчанию не хранится — так рецепт помнит только
 * то, что человек действительно поменял, и новые значения по умолчанию эффекта доходят до плана.
 */
export function withValue(step: EffectStep, spec: EffectParamSpec, value: number): EffectStep {
  const given = { ...step.given };
  if (value === spec.default) delete given[spec.name];
  else given[spec.name] = value;
  return { ...step, given };
}

/**
 * Значение с точностью шага параметра: 0,47 − 0,01 в двоичной арифметике даёт 0,45999999999999996,
 * а в рецепт и на экран должно попасть 0,46. Сетка шага не навязывается: округляются только знаки.
 */
export function roundToStep(value: number, step: number): number {
  const decimals = (String(step).split('.')[1] ?? '').length;
  return Number(value.toFixed(decimals));
}

/**
 * Цепочка черновика после «Взять параметры с плана»: эффекты источника заменяют такие же эффекты
 * черновика, остальные эффекты черновика остаются со своими значениями. Порядок — по реестру
 * (order — идентификаторы эффектов в порядке цепочки), как при добавлении эффекта.
 */
export function mergeSteps(draft: EffectStep[], source: EffectStep[], order: string[]): EffectStep[] {
  const taken = new Set(source.map((step) => step.effect));
  const rank = (step: EffectStep): number => order.indexOf(step.effect);
  return [...draft.filter((step) => !taken.has(step.effect)), ...source].sort((a, b) => rank(a) - rank(b));
}

/** Одинаковы ли цепочки (черновик и сохранённый рецепт). */
export function sameSteps(a: EffectStep[], b: EffectStep[]): boolean {
  const norm = (steps: EffectStep[]) =>
    JSON.stringify(
      steps.map((step) => ({
        effect: step.effect,
        given: Object.fromEntries(Object.entries(step.given).sort(([x], [y]) => x.localeCompare(y))),
        wind: step.wind ?? null
      }))
    );
  return norm(a) === norm(b);
}

/** Подпись плана: номер и строка песни; у сцены без строки — только номер. */
export function shotLabel(shot: Pick<EffectShot, 'shot' | 'title'>): string {
  return shot.title ? `${shot.shot} · ${shot.title}` : shot.shot;
}

/**
 * Длина плана в секундах по оси моментов эффекта: доля 0 — первый кадр, 1 — последний, поэтому
 * длина — время последнего кадра, а не всего ролика.
 */
export function planSeconds(shot: Pick<EffectShot, 'frames' | 'fps'>): number {
  return shot.fps > 0 ? Math.max(0, shot.frames - 1) / shot.fps : 0;
}

/** Секунды плана момента, заданного долей; с точностью до сотой. */
export function fractionToSeconds(fraction: number, shot: Pick<EffectShot, 'frames' | 'fps'>): number {
  return Math.round(fraction * planSeconds(shot) * 100) / 100;
}

/**
 * Доля плана для момента в секундах: момент ставится на ближайший кадр, доля — с точностью 4
 * знака (на плане в 10 с это меньше десятой кадра), в пределах 0–1.
 */
export function secondsToFraction(seconds: number, shot: Pick<EffectShot, 'frames' | 'fps'>): number {
  const last = Math.max(0, shot.frames - 1);
  if (!last || !(shot.fps > 0)) return 0;
  const frame = Math.min(last, Math.max(0, Math.round(seconds * shot.fps)));
  return Number((frame / last).toFixed(4));
}

/** Ширина и высота полного кадра, в котором Go считает свет: геометрия луча — в его пикселях. */
export const BEAM_FRAME = { width: 1920, height: 1080 } as const;

/** Источник и луч в пикселях полного кадра: точка источника, дальность, направление и половина конуса (радианы). */
export interface BeamGeometry {
  x: number;
  y: number;
  radius: number;
  direction: number;
  half: number;
}

const DIAGONAL = Math.hypot(BEAM_FRAME.width, BEAM_FRAME.height);

/** Геометрия луча по значениям параметров шага, как её считает Go. */
export function beamGeometry(beam: EffectBeam, value: (name: string) => number): BeamGeometry {
  return {
    x: value(beam.x) * BEAM_FRAME.width,
    y: value(beam.y) * BEAM_FRAME.height,
    radius: value(beam.radius) * DIAGONAL,
    direction: (value(beam.direction) * Math.PI) / 180,
    half: (value(beam.cone) * Math.PI) / 360
  };
}

/** Значение в пределах параметра с точностью его шага. */
function fit(spec: EffectParamSpec, value: number): number {
  return roundToStep(Math.min(spec.max, Math.max(spec.min, value)), spec.step);
}

/** Направление на экране из источника в точку: градусы 0–360 против часовой от направления вправо. */
function screenDegrees(from: { x: number; y: number }, x: number, y: number): number {
  return ((Math.atan2(from.y - y, x - from.x) * 180) / Math.PI + 360) % 360;
}

/** Новые значения источника, перенесённого в точку (x, y) пикселей полного кадра. */
export function dragSource(specs: { x: EffectParamSpec; y: EffectParamSpec }, x: number, y: number): { x: number; y: number } {
  return { x: fit(specs.x, x / BEAM_FRAME.width), y: fit(specs.y, y / BEAM_FRAME.height) };
}

/** Новое направление луча, когда его ручка перенесена в точку (x, y). */
export function dragDirection(spec: EffectParamSpec, geometry: BeamGeometry, x: number, y: number): number {
  return fit(spec, Math.round(screenDegrees(geometry, x, y)));
}

/** Новая дальность света, когда её ручка перенесена в точку (x, y): расстояние до источника. */
export function dragRadius(spec: EffectParamSpec, geometry: BeamGeometry, x: number, y: number): number {
  return fit(spec, Math.hypot(x - geometry.x, y - geometry.y) / DIAGONAL);
}

/** Новая ширина луча, когда ручка края конуса перенесена в точку (x, y): удвоенный угол от оси луча. */
export function dragCone(spec: EffectParamSpec, geometry: BeamGeometry, x: number, y: number): number {
  const axis = (geometry.direction * 180) / Math.PI;
  const off = Math.abs(((screenDegrees(geometry, x, y) - axis + 540) % 360) - 180);
  return fit(spec, Math.round(off * 2));
}
