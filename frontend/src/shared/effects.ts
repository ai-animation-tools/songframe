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

/** Эффект из реестра Go; windAngle — параметр наклона, который считается из ветра ("" — нет). */
export interface EffectKind {
  id: string;
  title: string;
  /** Когда и зачем применять эффект и что получится. */
  hint: string;
  params: EffectParamSpec[];
  windAngle: string;
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
  camera: boolean;
  /** Направление камеры первого кадра (градусы против часовой от востока), если camera. */
  heading: number;
  jobId: string;
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
