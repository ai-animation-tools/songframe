/** Локальный API настоящей страницы отделяет черновик формы от снимка сохранённого timing.json. */
import type { TimingFile, TimingView } from '@shared/types';
import { validateTiming } from '@shared/timing-validation';
import { makeTimingStoryView, normalizeTimingStoryFile } from './timingStories';
import { storyAccess } from './commonStories';
import { createTimingAgentModel, type TimingAgentVariant } from './timingAgentStories';
import { createStoryApi, type StoryOptions } from './storybook';

export const TIMING_PAGE_PROJECT = '/mock/timing-project';
export const TIMING_PAGE_SAVE_ERROR = 'Не удалось записать разметку. Черновик сохранён в форме; повторите попытку.';

interface TimingPageInspection {
  requests: TimingFile[];
  saved: TimingView;
}
let activeInspection: (() => TimingPageInspection) | null = null;

export function timingPageInspection(): TimingPageInspection {
  if (!activeInspection) throw new Error('Модель страницы таймингов не открыта.');
  return activeInspection();
}

/** Отсутствие audio в сценариях ввода сохраняет длительность и исключает ожидание декодера. */
export function timingPageOptions({ failSaveOnce = false, agent }: { failSaveOnce?: boolean; agent?: TimingAgentVariant } = {}): StoryOptions {
  return {
    shell: 'page',
    route: '/project/timing',
    app: {
      agentProvider: agent ? 'codex' : null,
      aiAccess: agent ? storyAccess : null,
      state: { packaged: false, problems: [], toolsRoot: null, localDir: '/mock/state', current: TIMING_PAGE_PROJECT, history: [], platform: 'linux' }
    },
    createApi: () => {
      let saved = makeTimingStoryView();
      if (!agent) saved.trackPath = null;
      saved.timing!.lines = saved.timing!.lines.map((line, index) => ({
        ...line,
        ...[
          { start: 0, end: 2.9 },
          { start: 3, end: 5 },
          { start: 14, end: 18 }
        ][index]
      }));
      if (agent) saved.timing!.lines[1] = { ...saved.timing!.lines[1], start: 17, end: 19 };
      const agentModel = agent ? createTimingAgentModel(agent) : null;
      const requests: TimingFile[] = [];
      const inspect = (): TimingPageInspection => structuredClone({ requests, saved });
      activeInspection = inspect;
      const session = createStoryApi({
        timingAgent: agentModel?.api,
        timing: {
          view: async () => structuredClone(saved),
          save: async (project, timing) => {
            if (project !== TIMING_PAGE_PROJECT) throw new Error('Сохранение отправлено в чужую модель проекта.');
            requests.push(structuredClone(timing));
            if (failSaveOnce && requests.length === 1) throw new Error(TIMING_PAGE_SAVE_ERROR);
            const problems = validateTiming(timing, saved.lyrics, saved.duration);
            if (problems.length) throw new Error(problems.join(' '));
            const normalized = normalizeTimingStoryFile(timing, saved);
            saved = { ...saved, timing: structuredClone(normalized) };
            return structuredClone(normalized);
          }
        }
      });
      session.onCleanup(() => {
        agentModel?.cleanup();
        if (activeInspection === inspect) activeInspection = null;
      });
      return session;
    }
  };
}
