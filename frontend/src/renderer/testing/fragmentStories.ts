/**
 * Локальная модель сборки фрагмента под музыку (animatic.fragment): задание вида tool завершается
 * через ms успехом или сбоем шага build_animatic; файл фрагмента показывается видео витрины.
 * Вызовы запоминаются, чтобы истории проверяли переданный диапазон.
 */
import type { Api } from '@shared/api';
import type { JobInfo } from '@shared/types';
import { deliveryJob } from './deliveryStories';
import { storyFileUrl, STORY_VIDEO_PATH } from './storybook';

export const FRAGMENT_FAILURE = 'Карточки устарели; обновите представления реестра планов.';

export interface FragmentModel {
  calls: { from: string; to: string }[];
  overrides: {
    animatic: Pick<Api['animatic'], 'fragment' | 'build'>;
    jobs: Pick<Api['jobs'], 'get' | 'list'>;
    shell: Pick<Api['shell'], 'fileUrl'>;
  };
  dispose(): void;
}

export function fragmentModel({ fail = false, ms = 400 }: { fail?: boolean; ms?: number } = {}): FragmentModel {
  const jobs = new Map<string, JobInfo>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const calls: FragmentModel['calls'] = [];
  return {
    calls,
    overrides: {
      animatic: {
        fragment: async (_project, from, to) => {
          calls.push({ from, to });
          const title = from === to ? `Фрагмент аниматика ${from}` : `Фрагмент аниматика ${from}–${to}`;
          const job = deliveryJob('tool', { id: `fragment-${calls.length}`, title });
          jobs.set(job.id, job);
          const timer = setTimeout(() => {
            timers.delete(timer);
            jobs.set(
              job.id,
              fail
                ? { ...job, status: 'failed', code: 1, error: FRAGMENT_FAILURE, finishedAt: job.startedAt }
                : { ...job, status: 'done', code: 0, finishedAt: job.startedAt }
            );
          }, ms);
          timers.add(timer);
          return structuredClone(job);
        },
        // Чужие вызовы сборки аниматика не относятся к фрагменту.
        build: async () => {
          throw new Error('animatic.build не используется в истории фрагмента');
        }
      },
      jobs: {
        get: async (id) => structuredClone(jobs.get(id) ?? null),
        list: async () => structuredClone([...jobs.values()])
      },
      // Файл фрагмента в проекте витрины — видео витрины.
      shell: { fileUrl: (path) => storyFileUrl(path.endsWith('fragment.mp4') ? STORY_VIDEO_PATH : path) }
    },
    dispose: () => {
      timers.forEach(clearTimeout);
      timers.clear();
    }
  };
}
