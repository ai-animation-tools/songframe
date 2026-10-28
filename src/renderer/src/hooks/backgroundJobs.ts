/** Какая страница сама сообщает об итоге задания: на других страницах итог показывает общий наблюдатель. */
import type { JobInfo, JobKind } from '@shared/types';
import type { AgentJob } from '@shared/agents';

const OWNER_ROUTES: Record<JobKind, string[]> = {
  submit: ['/project/production'],
  regenerate: ['/project/production'],
  accept: ['/project/production'],
  contact_sheet: ['/project/production'],
  check: ['/project/checks'],
  // Ручную пробу экспортирует «Монтаж пробы», пробу стыков собирают «Проверки».
  review: ['/project/checks', '/project/montage'],
  animatic: ['/project/animatic'],
  model_download: ['/project/timing'],
  // Общие инструменты запускают монтаж, пакет монтажёра и проверки — каждая из этих страниц сообщает сама.
  tool: ['/project/montage', '/project', '/project/checks']
};

/** Маршрут из hash без параметров: «#/project/montage?shots=…» → «/project/montage». */
export function routeOf(hash: string): string {
  return hash.replace(/^#/, '').split('?')[0] || '/';
}

export function ownerShowsResult(job: Pick<JobInfo, 'kind'>, route: string): boolean {
  return OWNER_ROUTES[job.kind].includes(route);
}

export function finishedNotice(job: Pick<JobInfo, 'title' | 'status' | 'error'>): { message: string; severity: 'success' | 'error' } {
  return job.status === 'failed'
    ? { message: `${job.title}: не выполнено.${job.error ? ` ${job.error}` : ''} Подробности — в журнале заданий.`, severity: 'error' }
    : { message: `${job.title}: выполнено.`, severity: 'success' };
}

/** Задания агента ведут страницы «Сценарий» и «Производство» (опоры провайдера-агента тоже); правило совпадает с системными уведомлениями. */
function agentPage(task: string): { route: string; page: string } {
  return task.startsWith('ai-clip-scenario:') || task === 'ai-clip-scenario'
    ? { route: '/project/scenario', page: 'Сценарий' }
    : { route: '/project/production', page: 'Производство' };
}

export function agentOwnerShowsResult(job: Pick<AgentJob, 'task'>, route: string): boolean {
  return agentPage(job.task).route === route;
}

export function agentFinishedNotice(job: Pick<AgentJob, 'task' | 'status'>): { message: string; severity: 'success' | 'warning' | 'error' } {
  const where = ` Откройте страницу «${agentPage(job.task).page}».`;
  if (job.status === 'completed') return { message: `Агент закончил работу: предложение готово к просмотру.${where}`, severity: 'success' };
  if (job.status === 'cancelled') return { message: `Задание агента остановлено.${where}`, severity: 'warning' };
  return { message: `Задание агента не выполнено. Подробности — в журнале заданий.${where}`, severity: 'error' };
}
