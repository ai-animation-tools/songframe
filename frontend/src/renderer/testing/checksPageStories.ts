/**
 * Локальная модель страницы «Проверки» в состоянии Go-версии: list/run/runAll и пересборка карточек
 * (updateViews) перенесены, пробы стыков, среда и производство — ещё нет. Задания создаются
 * выполняющимися и завершаются при следующем опросе jobs.list, как задания общего менеджера.
 */
import type { CheckId, CheckInfo, CheckOptions, JobInfo } from '@shared/types';
import { checksTexts } from '@shared/texts/checks';
import type { ApiMethod } from '../availability';
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

/** Методы группы, которые адаптер Go-версии пока отмечает недоступными. */
export const CHECKS_PAGE_UNAVAILABLE: readonly ApiMethod[] = [
  'checks.buildReview',
  'checks.listReviews',
  'checks.removeReview',
  'production.view',
  'environment.check'
];

interface ChecksPageInspection {
  runs: { id: CheckId; options: CheckOptions | undefined }[];
  runAll: (CheckOptions | undefined)[];
  updateViews: number;
}
let activeInspection: (() => ChecksPageInspection) | null = null;

export function checksPageInspection(): ChecksPageInspection {
  if (!activeInspection) throw new Error('Модель страницы проверок не открыта.');
  return activeInspection();
}

/** failing — проверки, шаг которых завершается кодом 1 (как отказ инструмента). */
export function checksPageOptions({ failing = [] }: { failing?: readonly CheckId[] } = {}): StoryOptions {
  return {
    shell: 'page',
    route: '/project/checks',
    unavailable: CHECKS_PAGE_UNAVAILABLE,
    app: {
      state: { packaged: false, problems: [], toolsRoot: null, localDir: '/mock/state', current: CHECKS_PAGE_PROJECT, history: [], platform: 'linux' }
    },
    createApi: () => {
      const inspection: ChecksPageInspection = { runs: [], runAll: [], updateViews: 0 };
      activeInspection = () => inspection;
      const jobs: JobInfo[] = [];
      const pending = new Set<string>();
      let counter = 0;
      const start = (title: string, checks: CheckInfo[], kind: JobInfo['kind'] = 'check'): JobInfo => {
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
          }
        },
        jobs: {
          list: async () => {
            advance();
            return structuredClone(jobs);
          }
        },
        shell: { openPath: async () => undefined }
      };
    }
  };
}
