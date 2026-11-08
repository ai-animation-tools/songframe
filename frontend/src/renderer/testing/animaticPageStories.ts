/**
 * Локальная модель страницы «Аниматик»: animatic.view/build/setStatus и jobs.list Go-версии без
 * Wails и инструментов. Сборка — задание вида animatic из двух шагов (update_scene_views, затем
 * build_animatic); как у общего менеджера, первый опрос после запуска видит его выполняющимся,
 * следующий — завершённым. Завершённая полная сборка заменяет latest свежим видео на просмотре,
 * проверка входов (planOnly) вид не меняет. Принятие пишет только статус в модели.
 */
import type { AnimaticShot, AnimaticView, JobInfo } from '@shared/types';
import { animaticTexts } from '@shared/texts/animatic';
import { applicationTexts } from '@shared/texts/application';
import { notificationsTexts } from '@shared/texts/notifications';
import { STORY_IMAGE_PATH, STORY_VIDEO_PATH, type StoryOptions } from './storybook';

export const ANIMATIC_PAGE_PROJECT = '/mock/Клип у старых ворот';
const LATEST = `${ANIMATIC_PAGE_PROJECT}/plan/animatic/latest`;
const BUILT_AT = '2026-11-04T12:00:00.000Z';
const VIDEO_SHA = 'a'.repeat(64);
const REBUILT_SHA = 'b'.repeat(64);

/** Причина блокировки из reviewProblem Go-сервиса: сценарий нужно утвердить заново. */
export const ANIMATIC_BLOCKED_REASON = applicationTexts.scenarioReviewRequired;
/** Проблемы свежести устаревшей сборки — фразы Go-сервиса из словаря страницы. */
export const ANIMATIC_STALE_PROBLEMS = [animaticTexts.main.registryChanged, animaticTexts.main.acceptedEditChanged({ shot: 'M02' })];
/** Сбой задания, как его сообщает шаг build_animatic. */
export const ANIMATIC_JOB_ERROR = 'M03: длительность карточки не совпадает с окном плана.';

/** Три плана на восьми секундах видео витрины: анимация с речью, опоры и карточка. */
export const ANIMATIC_SHOTS: AnimaticShot[] = [
  {
    id: 'M01',
    title: 'Олег у калитки',
    original: 'У старых ворот',
    sequence: 'S01',
    sequenceTitle: 'Двор',
    start: 0,
    end: 3,
    frames: 72,
    action: 'Олег открывает калитку и оглядывается.',
    camera: 'Средний план, медленный наезд.',
    lipsync: true,
    media: 'video',
    cardPath: null,
    lastCardPath: null
  },
  {
    id: 'M02',
    title: 'Грядки на рассвете',
    original: 'Солнце встаёт над огородом',
    sequence: 'S01',
    sequenceTitle: 'Двор',
    start: 3,
    end: 5.5,
    frames: 60,
    action: 'Туман сходит с грядок.',
    camera: 'Общий план, панорама слева направо.',
    lipsync: false,
    media: 'keyframes',
    cardPath: STORY_IMAGE_PATH,
    lastCardPath: `${LATEST}/cards/M02-last/story-image.png`
  },
  {
    id: 'M03',
    title: 'Пугало машет рукавом',
    original: '',
    sequence: 'S02',
    sequenceTitle: 'Поле',
    start: 5.5,
    end: 8,
    frames: 60,
    action: '',
    camera: '',
    lipsync: false,
    media: 'card',
    cardPath: `${LATEST}/cards/M03/story-image.png`,
    lastCardPath: null
  }
];

export type AnimaticPageState = 'none' | 'review' | 'accepted' | 'stale' | 'blocked';

interface AnimaticPageInspection {
  /** Аргумент planOnly каждого вызова animatic.build. */
  builds: boolean[];
  statuses: ('approved' | 'review')[];
  openedPaths: string[];
}
let activeInspection: (() => AnimaticPageInspection) | null = null;

/** Вызовы модели открытой истории для проверок play. */
export function animaticPageInspection(): AnimaticPageInspection {
  if (!activeInspection) throw new Error('Модель страницы аниматика не открыта.');
  return activeInspection();
}

function built(fresh: boolean, sha = VIDEO_SHA): NonNullable<AnimaticView['built']> {
  return {
    videoPath: `${LATEST}/${STORY_VIDEO_PATH.split('/').pop()}`,
    manifestPath: `${LATEST}/manifest.json`,
    videoSha256: sha,
    duration: 8,
    totalFrames: 192,
    builtAt: BUILT_AT,
    fresh,
    counts: { video: 1, cards: 1, keyframes: 1 }
  };
}

/** Начальный вид latest для состояния истории. */
function initialView(state: AnimaticPageState): AnimaticView {
  switch (state) {
    case 'none':
      return { built: null, shots: [], approval: { status: 'none', approvedSha256: null, current: false }, cardsFresh: false, problems: [] };
    case 'review':
      return {
        built: built(true),
        shots: structuredClone(ANIMATIC_SHOTS),
        approval: { status: 'review', approvedSha256: null, current: false },
        cardsFresh: true,
        problems: []
      };
    case 'accepted':
      return {
        built: built(true),
        shots: structuredClone(ANIMATIC_SHOTS),
        approval: { status: 'approved', approvedSha256: VIDEO_SHA, current: true },
        cardsFresh: true,
        problems: []
      };
    // Принятая прежде сборка устарела: принятие не текущее, проблемы называют причину.
    case 'stale':
      return {
        built: built(false),
        shots: structuredClone(ANIMATIC_SHOTS),
        approval: { status: 'approved', approvedSha256: VIDEO_SHA, current: false },
        cardsFresh: false,
        problems: [...ANIMATIC_STALE_PROBLEMS]
      };
    // Как AnimaticService.View при неутверждённом сценарии: сборка несвежая, причина — blockedReason.
    case 'blocked':
      return {
        built: built(false),
        shots: structuredClone(ANIMATIC_SHOTS),
        approval: { status: 'approved', approvedSha256: VIDEO_SHA, current: false },
        cardsFresh: false,
        problems: [ANIMATIC_BLOCKED_REASON],
        blockedReason: ANIMATIC_BLOCKED_REASON
      };
  }
}

/**
 * state — начальное состояние latest; failing — задание сборки завершается ошибкой шага
 * build_animatic; loadFailures — сколько первых чтений animatic.view отклоняются.
 */
export function animaticPageOptions({
  state = 'review',
  failing = false,
  loadFailures = 0
}: { state?: AnimaticPageState; failing?: boolean; loadFailures?: number } = {}): StoryOptions {
  return {
    shell: 'page',
    route: '/project/animatic',
    app: {
      state: { packaged: false, problems: [], localDir: '/mock/state', current: ANIMATIC_PAGE_PROJECT, history: [], platform: 'linux' }
    },
    createApi: () => {
      const inspection: AnimaticPageInspection = { builds: [], statuses: [], openedPaths: [] };
      activeInspection = () => inspection;
      let view = initialView(state);
      let failuresLeft = loadFailures;
      const jobs: JobInfo[] = [];
      const pending = new Set<string>();
      const planOnlyJobs = new Set<string>();
      let counter = 0;
      // Первый опрос после запуска видит задание выполняющимся, следующий — завершённым.
      const advance = (): void => {
        for (const job of jobs) {
          if (job.status !== 'running' || pending.delete(job.id)) continue;
          const [views, buildStep] = job.steps;
          views.status = 'done';
          views.code = 0;
          buildStep.status = failing ? 'failed' : 'done';
          buildStep.code = failing ? 1 : 0;
          job.status = failing ? 'failed' : 'done';
          job.code = failing ? 1 : 0;
          job.finishedAt = '2026-11-04T12:00:05.000Z';
          if (failing) job.error = ANIMATIC_JOB_ERROR;
          // Новая полная сборка заменяет latest: видео свежее и снова ждёт просмотра.
          else if (!planOnlyJobs.has(job.id))
            view = {
              built: { ...built(true, REBUILT_SHA), builtAt: job.finishedAt },
              shots: structuredClone(ANIMATIC_SHOTS),
              approval: { status: view.approval.status === 'none' ? 'none' : 'review', approvedSha256: null, current: false },
              cardsFresh: true,
              problems: []
            };
        }
      };
      return {
        animatic: {
          view: async (project) => {
            if (project !== ANIMATIC_PAGE_PROJECT) throw new Error('Модель знает только проект истории.');
            if (failuresLeft > 0) {
              failuresLeft -= 1;
              throw new Error(animaticTexts.main.manifestCorrupt);
            }
            return structuredClone(view);
          },
          build: async (_project, planOnly) => {
            inspection.builds.push(planOnly);
            if (view.blockedReason) throw new Error(view.blockedReason);
            counter += 1;
            const job: JobInfo = {
              id: `animatic-${counter}`,
              project: ANIMATIC_PAGE_PROJECT,
              kind: 'animatic',
              title: planOnly ? notificationsTexts.animaticCheckTitle : animaticTexts.main.buildTitle,
              status: 'running',
              startedAt: '2026-11-04T12:00:00.000Z',
              finishedAt: null,
              log: '',
              code: null,
              steps: [
                { label: animaticTexts.main.updateViewsStep, tool: 'update_scene_views', status: 'running', code: null },
                { label: planOnly ? animaticTexts.main.checkInputsStep : animaticTexts.main.buildStep, tool: 'build_animatic', status: 'pending', code: null }
              ]
            };
            jobs.unshift(job);
            pending.add(job.id);
            if (planOnly) planOnlyJobs.add(job.id);
            return structuredClone(job);
          },
          // Как Go-сервис: принимается только свежая сборка, возврат на просмотр снимает принятие.
          setStatus: async (_project, status) => {
            inspection.statuses.push(status);
            if (status === 'approved' && (!view.built?.fresh || view.blockedReason)) throw new Error(animaticTexts.main.freshBuildRequired);
            view = {
              ...view,
              approval:
                status === 'approved'
                  ? { status: 'approved', approvedSha256: view.built?.videoSha256 ?? null, current: true }
                  : { status: 'review', approvedSha256: null, current: false }
            };
            return structuredClone(view);
          }
        },
        jobs: {
          list: async () => {
            advance();
            return structuredClone(jobs);
          }
        },
        shell: {
          openPath: async (path) => {
            inspection.openedPaths.push(path);
          }
        }
      };
    }
  };
}
