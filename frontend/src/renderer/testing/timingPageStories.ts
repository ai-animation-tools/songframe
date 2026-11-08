/** Локальный API настоящей страницы отделяет черновик формы от снимка сохранённого timing.json. */
import type { TimingFile, TimingView } from '@shared/types';
import { validateTiming } from '@shared/timing-validation';
import { makeTimingStoryView, normalizeTimingStoryFile } from './timingStories';
import { timingLocalInspection, createTimingLocalModel, type TimingLocalVariant } from './timingLocalStories';
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
export function timingPageOptions({
  failSaveOnce = false,
  local,
  withoutLyrics = false,
  editor,
  selection
}: {
  failSaveOnce?: boolean;
  local?: TimingLocalVariant;
  withoutLyrics?: boolean;
  editor?: 'gaps' | 'candidates';
  selection?: 'joined-pair' | 'gapped-pair' | 'locked-pair' | 'mixed-candidate-pair' | 'empty';
} = {}): StoryOptions {
  return {
    shell: 'page',
    route: '/project/timing',
    app: {
      state: {
        packaged: false,
        problems: [],
        localDir: '/mock/state',
        current: TIMING_PAGE_PROJECT,
        history: [],
        platform: 'linux'
      }
    },
    createApi: () => {
      let saved = makeTimingStoryView();
      if (withoutLyrics) saved.lyrics = [];
      if (!local) saved.trackPath = null;
      saved.timing!.lines = saved.timing!.lines.map((line, index) => ({
        ...line,
        ...[
          { start: 0, end: 2.9 },
          { start: 3, end: 5 },
          { start: 14, end: 18 }
        ][index]
      }));
      // Локальный ASR запускается над сохранённым документом: исходные строки не пересекаются.
      if (local) {
        saved.timing!.lines[1] = { ...saved.timing!.lines[1], start: 17, end: 19 };
        saved.timing!.lines[2] = { ...saved.timing!.lines[2], start: 20, end: 23 };
      }
      if (editor) {
        // Одинаковый припев и пропуск в середине проверяют устойчивую привязку по source_line.
        saved.lyrics = [
          { number: 1, text: '[Куплет]', header: true },
          { number: 2, text: 'У старых ворот начинается утро', header: false },
          { number: 3, text: 'Пропущенная строка в середине', header: false },
          { number: 4, text: 'И снова зовёт нас знакомая дорога', header: false },
          { number: 5, text: '[Припев]', header: true },
          { number: 6, text: 'И снова зовёт нас знакомая дорога', header: false }
        ];
        saved.timing!.lines = [
          { id: 1, source_line: 2, start: 0, end: 2.9, verified: false, note: '' },
          { id: 2, source_line: 4, start: 14, end: 18, verified: true, note: 'сверка на слух выполнена' },
          { id: 3, source_line: 6, start: 20, end: 23, verified: false, note: '' }
        ];
        if (editor === 'candidates')
          saved.timing!.candidates = [{ source_line: 3, start: 1, end: 4, reason: 'Низкая акустическая оценка', acoustic_score: 0.3 }];
      }
      // Сценарии выделения используют настоящий MP3 и короткие соседние строки; ASR им не требуется.
      if (selection) saved = makeTimingStoryView(selection === 'mixed-candidate-pair' ? 'locked-pair' : selection);
      if (selection === 'mixed-candidate-pair') {
        // V снимает блокировку принятой строки, но не должен принимать соседнее сомнительное предложение.
        const candidate = saved.timing!.lines[1];
        saved.timing!.lines = saved.timing!.lines.filter((line) => line.source_line !== candidate.source_line);
        saved.timing!.lines[0] = { ...saved.timing!.lines[0], verified: true, note: 'сверка на слух выполнена' };
        saved.timing!.candidates = [
          { source_line: candidate.source_line, start: candidate.start, end: candidate.end, reason: 'Низкая акустическая оценка', note: 'Проверить тихий вход' }
        ];
      }
      const requests: TimingFile[] = [];
      let resultReadFailed = false;
      const inspect = (): TimingPageInspection => structuredClone({ requests, saved });
      activeInspection = inspect;
      const localModel = local
        ? createTimingLocalModel(
            local,
            () => saved,
            (next) => {
              saved = next;
            }
          )
        : null;
      const session = createStoryApi({
        shell: localModel?.api.shell,
        jobs: localModel?.api.jobs,
        timing: {
          ...localModel?.api.timing,
          view: async (project) => {
            if (local === 'reload-failure' && timingLocalInspection().starts.length > 0 && !resultReadFailed) {
              resultReadFailed = true;
              throw new Error('Не удалось прочитать записанный результат. Повторите чтение.');
            }
            const view = structuredClone(saved);
            if (project !== TIMING_PAGE_PROJECT) view.timing!.lines[0] = { ...view.timing!.lines[0], start: 30, end: 34 };
            return view;
          },
          save: async (project, timing) => {
            if (project !== TIMING_PAGE_PROJECT) throw new Error('Сохранение отправлено в чужую модель проекта.');
            requests.push(structuredClone(timing));
            if (failSaveOnce && requests.length === 1) throw new Error(TIMING_PAGE_SAVE_ERROR);
            const problems = validateTiming(timing, saved.lyrics, saved.duration);
            if (problems.length) throw new Error(problems.join(' '));
            const normalized = { ...normalizeTimingStoryFile(timing, saved), candidates: timing.candidates, line_order: timing.line_order };
            saved = { ...saved, timing: structuredClone(normalized) };
            return structuredClone(normalized);
          }
        }
      });
      session.onCleanup(() => {
        localModel?.cleanup();
        if (activeInspection === inspect) activeInspection = null;
      });
      return session;
    }
  };
}
