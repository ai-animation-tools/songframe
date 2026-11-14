/**
 * Локальная модель window.api.projectHistory для витрины: репозиторий проекта в памяти истории.
 * save фиксирует несохранённые разделы новой точкой, restore возвращает раздел (он становится
 * несохранённым), compareScenario отдаёт заданное сравнение. Настоящий Git не запускается.
 */
import type { ProjectHistoryStatus, ProjectPoint, ProjectRestoreResult, ProjectScenarioComparison, ProjectSection } from '@shared/types';
import type { ApiOverrides } from './storybook';

export const HISTORY_POINTS: ProjectPoint[] = [
  { id: 'c3', date: '2026-11-14T10:20:00+03:00', message: 'Автоматическая точка перед применением сценария', sections: ['scenario', 'views'] },
  { id: 'c2', date: '2026-11-13T18:05:00+03:00', message: 'Создал кастинг', sections: ['cast', 'views'] },
  { id: 'c1', date: '2026-11-12T12:00:00+03:00', message: 'Разметил трек на слух', sections: ['timing', 'views'] }
];

export const HISTORY_COMPARISON: ProjectScenarioComparison = {
  missing: false,
  shots: [
    { id: 'M02', reason: 'изменена постановка плана', state: 'completed', produced: true },
    { id: 'M04', reason: 'новый план', state: 'planned', produced: false }
  ],
  removed: ['M07']
};

export interface HistoryModelOptions {
  available?: boolean;
  sections?: ProjectSection[];
  changedFiles?: number;
  autoError?: string;
  points?: ProjectPoint[];
  comparison?: ProjectScenarioComparison;
}

/** Группа projectHistory с изменяемым состоянием одной истории. */
export function historyApi(options: HistoryModelOptions = {}): ApiOverrides['projectHistory'] {
  let points = structuredClone(options.points ?? HISTORY_POINTS);
  let sections: ProjectSection[] = [...(options.sections ?? ['timing', 'scenario', 'views'])];
  let changedFiles = options.changedFiles ?? 5;
  let autoError = options.autoError ?? '';
  const status = (): ProjectHistoryStatus => ({
    available: options.available ?? true,
    sections: [...sections],
    changedFiles,
    head: points[0] ? { ...points[0] } : null,
    autoError
  });
  return {
    status: async () => status(),
    points: async () => structuredClone(points),
    save: async (_project, message) => {
      if (sections.length) points = [{ id: `c${points.length + 1}`, date: '2026-11-14T12:00:00+03:00', message, sections: [...sections] }, ...points];
      sections = [];
      changedFiles = 0;
      autoError = '';
      return status();
    },
    checkpoint: async () => undefined,
    restore: async (_project, _point, section): Promise<ProjectRestoreResult> => {
      sections = [section, 'views'];
      changedFiles = 2;
      return { status: status(), viewsError: '' };
    },
    compareScenario: async () => structuredClone(options.comparison ?? HISTORY_COMPARISON)
  };
}
