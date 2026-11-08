/** Согласованные данные витрины производных планов; все операции меняют только локальную модель истории. */
import {
  checkedDerivedRecipe,
  derivedRecipeProblem,
  type DerivedShotApi,
  type DerivedShotPreview,
  type DerivedShotRecipe,
  type DerivedShotView
} from '@shared/derived-shot';
import { derivedMainTexts as texts } from '@shared/texts/derived-shot-main';
import type { JobInfo } from '@shared/types';

export const DERIVED_STORY_PROJECT = '/mock/Клип с длинным названием';
export const DERIVED_CANONICAL_PROJECT = '/mock/Канонический путь клипа';
export const DERIVED_SOURCE_PATH = '/mock/story-derived-source-150.mp4';
export const DERIVED_RECIPE: DerivedShotRecipe = { mode: 'repeat', start_frame: 0, end_frame_exclusive: 30 };

export function derivedPreview(overrides: Partial<DerivedShotPreview> = {}): DerivedShotPreview {
  const frames = overrides.frames ?? 92;
  const recipe = overrides.recipe ?? structuredClone(DERIVED_RECIPE);
  // Короткие клипы заранее подготовлены для витрины: модель показывает переходы API,
  // но не исполняет произвольный изменённый рецепт через настоящий монтажный runtime.
  const videoPath =
    frames === 62 ? '/mock/story-derived-preview-62.mp4' : recipe.mode === 'still' ? '/mock/story-derived-still-92.mp4' : '/mock/story-derived-preview-92.mp4';
  return {
    id: 'preview-1',
    videoPath,
    candidatePath: '/mock/plan/derived/M02/preview-1/video.mp4',
    resultToken: 'a'.repeat(64),
    recipe,
    frames,
    fresh: true,
    problem: null,
    accepted: false,
    ...overrides
  };
}

export function derivedView(overrides: Partial<DerivedShotView> = {}): DerivedShotView {
  return {
    project: DERIVED_CANONICAL_PROJECT,
    shot: 'M02',
    title: 'Олег ждёт у ворот',
    action: 'Олег останавливается у ворот. Сохраняем выражение лица и направление взгляда; камера остаётся на месте.',
    sourceShot: 'M01',
    sourceTitle: 'Подъезд к даче — непрерывный длинный проход камеры вдоль забора',
    sourcePath: DERIVED_SOURCE_PATH,
    sourceFrames: 150,
    targetFrames: 92,
    recipe: structuredClone(DERIVED_RECIPE),
    preview: null,
    job: null,
    problem: null,
    toolsProblem: null,
    hasAsset: false,
    ...overrides
  };
}

function derivedJob(operation: 'build' | 'accept', shot: string, sequence: number): JobInfo {
  return {
    id: `derived-${shot}-${sequence}`,
    project: DERIVED_CANONICAL_PROJECT,
    kind: 'tool',
    title: operation === 'build' ? texts.buildTitle({ shot }) : texts.acceptTitle({ shot }),
    status: 'running',
    startedAt: new Date().toISOString(),
    finishedAt: null,
    log: '',
    code: null,
    steps: [{ label: operation === 'build' ? texts.buildStep : texts.acceptStep, tool: 'derive_shot', status: 'running', code: null }]
  };
}

/** Текст первого сбоя приёмки при failAcceptOnce; история сверяет его с показанной ошибкой. */
export const DERIVED_ACCEPT_FAILURE = 'Не удалось обновить представления. Кандидат сохранён: повторите приёмку без новой сборки.';

/** Вызов сборки или приёмки в том виде, в каком его получила модель, до проверок. */
export type DerivedScenarioCall = { operation: 'build' } | { operation: 'accept'; id: string; resultToken: string; replace: boolean };

export interface DerivedScenarioOptions {
  view?: Partial<DerivedShotView>;
  initialDelay?: number;
  failLoadOnce?: boolean;
  failAcceptOnce?: boolean;
  /** Необязательный наблюдатель: истории показывают счётчики, чтобы проверить отсутствие лишних вызовов. */
  onCall?(call: DerivedScenarioCall): void;
}

/** Настоящий useDerivedShot видит running и получает квитанцию только следующим опросом через 1800 мс.
 * Очистка отменяет даже незавершённые ответы: соседняя история не наследует задания и кандидаты. */
export function createDerivedScenario(options: DerivedScenarioOptions = {}): { api: { derivedShots: DerivedShotApi }; dispose(): void } {
  const views = new Map<string, DerivedShotView>();
  const timers = new Map<ReturnType<typeof setTimeout>, () => void>();
  let disposed = false;
  let sequence = 0;
  let failedLoad = false;
  let failedAccept = false;
  const get = (shot: string): DerivedShotView => {
    let view = views.get(shot);
    if (!view) {
      view = derivedView({
        ...options.view,
        shot,
        ...(shot === 'M03' ? { title: 'Второй производный план', targetFrames: 62, recipe: { mode: 'still', frame: 12 }, preview: null } : {})
      });
      views.set(shot, view);
    }
    return view;
  };
  const later = (ms: number, action: () => void, cancel = (): void => {}): void => {
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (!disposed) action();
    }, ms);
    timers.set(timer, cancel);
  };
  const wait = (ms: number): Promise<void> => new Promise((resolve) => later(ms, resolve, resolve));
  const snapshot = (view: DerivedShotView): DerivedShotView => structuredClone(view);
  const ready = (view: DerivedShotView): void => {
    if (disposed) throw new Error('История уже закрыта.');
    if (view.job?.status === 'running') throw new Error(texts.busy);
  };
  const executable = (view: DerivedShotView): void => {
    ready(view);
    if (view.problem || view.toolsProblem) throw new Error(view.problem ?? view.toolsProblem!);
  };
  const terminal = (view: DerivedShotView, failure?: string): void => {
    if (!view.job) return;
    view.job = {
      ...view.job,
      status: failure ? 'failed' : 'done',
      code: failure ? 1 : 0,
      error: failure,
      finishedAt: new Date().toISOString(),
      steps: view.job.steps.map((step) => ({ ...step, status: failure ? 'failed' : 'done', code: failure ? 1 : 0 }))
    };
  };
  const derivedShots: DerivedShotApi = {
    async view(_project, shot) {
      if (options.initialDelay) await wait(options.initialDelay);
      if (disposed) throw new Error('История уже закрыта.');
      if (options.failLoadOnce && !failedLoad) {
        failedLoad = true;
        throw new Error('Не удалось прочитать рецепт. Повторите загрузку: сохранённые данные доступны.');
      }
      return snapshot(get(shot));
    },
    async save(_project, shot, value) {
      const view = get(shot);
      ready(view);
      await wait(450);
      ready(view);
      view.recipe = checkedDerivedRecipe(value);
      if (view.preview) view.preview = { ...view.preview, fresh: false, problem: texts.previewStale };
      return snapshot(view);
    },
    async build(_project, shot, value) {
      options.onCall?.({ operation: 'build' });
      const view = get(shot);
      executable(view);
      const recipe = checkedDerivedRecipe(value);
      const problem = derivedRecipeProblem(recipe, view.targetFrames, view.sourceFrames);
      if (problem) throw new Error(problem);
      await wait(400);
      executable(view);
      view.recipe = recipe;
      view.preview = null;
      const current = ++sequence;
      view.job = derivedJob('build', shot, current);
      later(1000, () => {
        view.preview = derivedPreview({
          id: `preview-${shot}-${current}`,
          candidatePath: `/mock/plan/derived/${shot}/preview-${current}/video.mp4`,
          resultToken: String(current).padStart(64, '0'),
          recipe: structuredClone(recipe),
          frames: view.targetFrames
        });
        terminal(view);
      });
      return snapshot(view);
    },
    async accept(_project, shot, id, resultToken, replace) {
      options.onCall?.({ operation: 'accept', id, resultToken, replace });
      const view = get(shot);
      executable(view);
      if (!view.preview || view.preview.id !== id || view.preview.resultToken !== resultToken) throw new Error(texts.previewMissing);
      if (!view.preview.fresh) throw new Error(texts.previewStale);
      if (view.hasAsset && !replace) throw new Error(texts.replacementRequired);
      await wait(400);
      executable(view);
      view.job = derivedJob('accept', shot, ++sequence);
      later(1100, () => {
        if (options.failAcceptOnce && !failedAccept) {
          failedAccept = true;
          terminal(view, DERIVED_ACCEPT_FAILURE);
          return;
        }
        view.hasAsset = true;
        view.preview = { ...view.preview!, accepted: true };
        terminal(view);
      });
      return snapshot(view);
    }
  };
  return {
    api: { derivedShots },
    dispose() {
      disposed = true;
      for (const [timer, cancel] of timers) {
        clearTimeout(timer);
        cancel();
      }
      timers.clear();
      views.clear();
    }
  };
}
