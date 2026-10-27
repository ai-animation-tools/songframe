import type { JobInfo } from '@shared/types';

/** Результат отдельной проверки, включая незапущенный шаг остановленного задания. */
export interface CheckOutcome {
  job: JobInfo;
  status: 'running' | 'done' | 'failed' | 'skipped';
  code: number | null;
}
