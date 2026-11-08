/**
 * Локальная модель страницы «Проверки» Go-версии: list/run/runAll, пересборка карточек (updateViews),
 * сводка производства (production.view) и пробы стыков (buildReview/listReviews/removeReview). Задания
 * создаются выполняющимися и завершаются при следующем опросе jobs.list, как задания общего менеджера;
 * завершённая сборка пробы (не planOnly) добавляет её в список plan/batches.
 */
import type { CheckId, CheckInfo, CheckOptions, JobInfo, ReviewInfo, ReviewOptions, ShotProduction } from '@shared/types';
import { checksTexts } from '@shared/texts/checks';
import type { StoryOptions } from './storybook';

export const CHECKS_PAGE_PROJECT = '/mock/checks-project';

/** CHECKS Go-сервиса: те же тексты, что у оригинала. */
export const CHECKS_PAGE_LIST: CheckInfo[] = [
  { id: 'lint', label: checksTexts.sceneDataLabel, description: checksTexts.sceneDataDescription, tool: 'lint_registry', needsScenes: true },
  { id: 'views', label: checksTexts.viewsLabel, description: checksTexts.viewsDescription, tool: 'update_scene_views', needsScenes: true },
  { id: 'assets', label: checksTexts.assetsLabel, description: checksTexts.assetsDescription, tool: 'check_assets', needsScenes: true },
  { id: 'workspace', label: checksTexts.workspaceLabel, description: checksTexts.workspaceDescription, tool: 'check_workspace', needsScenes: true },
  { id: 'status', label: checksTexts.statusLabel, description: checksTexts.statusDescription, tool: 'shot_status', needsScenes: true }
];

/** Проба, уже собранная в plan/batches: видео витрины и одноимённый рецепт. */
export function checksPageReview(shots: readonly string[], stamp = '20261104-120000'): ReviewInfo {
  const dir = `${CHECKS_PAGE_PROJECT}/plan/batches/review-${shots.join('-')}-${stamp}`;
  return {
    dir,
    // Basename совпадает с видео витрины: плеер пробы получает настоящее медиа.
    video: `${dir}/story-video.mp4`,
    manifest: `${dir}/story-video.json`,
    shots: [...shots],
    totalFrames: 192,
    createdAt: '2026-11-04T12:00:00.000Z'
  };
}

/**
 * План сводки производства: страница проверок берёт из неё готовность сценария, а проба — порядок
 * планов и наличие принятого видео (asset.video; без него план идёт карточкой).
 */
function shot(id: string, start: number, end: number, video: 'accepted' | 'missing' | 'none' = 'none'): ShotProduction {
  const dir = `${CHECKS_PAGE_PROJECT}/assets/shots/${id}`;
  return {
    id,
    title: `План ${id}`,
    original: '',
    start,
    end,
    lipsync: false,
    state: 'planned',
    stageLabel: video === 'accepted' ? 'Принят' : 'Запланирован',
    regenerateProblem: null,
    derivedFrom: null,
    attention: null,
    asset: video === 'none' ? null : { dir, video: video === 'accepted' ? `${dir}/${id}.mp4` : null, original: null },
    packages: []
  };
}

interface ChecksPageInspection {
  runs: { id: CheckId; options: CheckOptions | undefined }[];
  runAll: (CheckOptions | undefined)[];
  updateViews: number;
  reviews: ReviewOptions[];
  removedReviews: string[];
}
let activeInspection: (() => ChecksPageInspection) | null = null;

export function checksPageInspection(): ChecksPageInspection {
  if (!activeInspection) throw new Error('Модель страницы проверок не открыта.');
  return activeInspection();
}

/**
 * failing — проверки, шаг которых завершается кодом 1 (как отказ инструмента); noShots — в сценарии ещё нет
 * планов; reviews — пробы, уже собранные в plan/batches.
 */
export function checksPageOptions({
  failing = [],
  noShots = false,
  reviews: initialReviews = [checksPageReview(['M01', 'M02'])]
}: { failing?: readonly CheckId[]; noShots?: boolean; reviews?: readonly ReviewInfo[] } = {}): StoryOptions {
  return {
    shell: 'page',
    route: '/project/checks',
    app: {
      state: { packaged: false, problems: [], localDir: '/mock/state', current: CHECKS_PAGE_PROJECT, history: [], platform: 'linux' }
    },
    createApi: () => {
      const inspection: ChecksPageInspection = { runs: [], runAll: [], updateViews: 0, reviews: [], removedReviews: [] };
      activeInspection = () => inspection;
      const jobs: JobInfo[] = [];
      const pending = new Set<string>();
      let reviews = structuredClone([...initialReviews]);
      /** Задания полной сборки пробы и планы, которые она запишет в plan/batches. */
      const reviewBuilds = new Map<string, readonly string[]>();
      let counter = 0;
      const start = (title: string, checks: readonly Pick<CheckInfo, 'label' | 'tool'>[], kind: JobInfo['kind'] = 'check'): JobInfo => {
        counter += 1;
        const job: JobInfo = {
          id: `check-${counter}`,
          project: CHECKS_PAGE_PROJECT,
          kind,
          title,
          status: 'running',
          startedAt: '2026-11-04T12:00:00.000Z',
          finishedAt: null,
          log: '',
          code: null,
          steps: checks.map((check) => ({ label: check.label, tool: check.tool, status: 'pending', code: null }))
        };
        jobs.unshift(job);
        pending.add(job.id);
        return structuredClone(job);
      };
      // Первый опрос после запуска видит задание выполняющимся, следующий — завершённым.
      const advance = (): void => {
        for (const job of jobs) {
          if (job.status !== 'running') continue;
          if (pending.delete(job.id)) continue;
          for (const step of job.steps) {
            const failed = failing.some((id) => CHECKS_PAGE_LIST.find((check) => check.id === id)?.tool === step.tool);
            step.status = failed ? 'failed' : 'done';
            step.code = failed ? 1 : 0;
          }
          const failedStep = job.steps.find((step) => step.code !== 0);
          job.status = failedStep ? 'failed' : 'done';
          job.code = failedStep ? 1 : 0;
          job.finishedAt = '2026-11-04T12:00:01.000Z';
          const built = reviewBuilds.get(job.id);
          if (built && job.status === 'done') reviews = [checksPageReview(built, `20261104-12000${reviews.length + 1}`), ...reviews];
        }
      };
      return {
        checks: {
          list: async () => structuredClone(CHECKS_PAGE_LIST),
          run: async (_project, id, options) => {
            inspection.runs.push({ id, options });
            const check = CHECKS_PAGE_LIST.find((item) => item.id === id)!;
            return start(checksTexts.checkJobTitle(check.label), [check]);
          },
          runAll: async (_project, options) => {
            inspection.runAll.push(options);
            return start(checksTexts.allChecksJobTitle, CHECKS_PAGE_LIST);
          },
          // Пересборка — задание вида tool с одним шагом update_scene_views без --check, как у Go-сервиса.
          updateViews: async () => {
            inspection.updateViews += 1;
            return start(
              checksTexts.updateViewsJobTitle,
              [{ ...CHECKS_PAGE_LIST.find((check) => check.id === 'views')!, label: checksTexts.updateViewsJobTitle }],
              'tool'
            );
          },
          // Проба — задание вида review с одним шагом build_review; planOnly только проверяет входы.
          buildReview: async (_project, options) => {
            inspection.reviews.push(structuredClone(options));
            if (!options.shots.length) throw new Error(checksTexts.reviewShotsRequired);
            const label = options.planOnly ? checksTexts.checkReviewStep : checksTexts.buildReviewStep;
            const job = start(checksTexts.reviewJobTitle(options), [{ label, tool: 'build_review' }], 'review');
            if (!options.planOnly) reviewBuilds.set(job.id, [...options.shots]);
            return job;
          },
          listReviews: async () => structuredClone(reviews),
          removeReview: async (_project, path) => {
            inspection.removedReviews.push(path);
            if (!reviews.some((review) => review.video === path)) throw new Error(checksTexts.reviewNotFound);
            reviews = reviews.filter((review) => review.video !== path);
          }
        },
        jobs: {
          list: async () => {
            advance();
            return structuredClone(jobs);
          }
        },
        production: {
          view: async () => ({
            shots: noShots ? [] : [shot('M01', 0, 4, 'accepted'), shot('M02', 4, 8), shot('M03', 8, 12, 'missing'), shot('M04', 12, 16, 'accepted')],
            broken: [],
            problems: [],
            tools: { providers: {} }
          })
        },
        shell: { openPath: async () => undefined }
      };
    }
  };
}
