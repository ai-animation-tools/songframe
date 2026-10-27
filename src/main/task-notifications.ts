import type { AgentEvent } from '@shared/agents';
import type { NotificationTarget } from '@shared/notifications';
import type { JobInfo } from '@shared/types';

export interface TaskNotice {
  title: string;
  body: string;
  target: NotificationTarget;
}

/** Выбирает завершённые операции для уведомлений; показ и переход принадлежат адаптеру Electron. */
export class TaskNotifications {
  private readonly deliveredJobs = new Set<string>();
  private readonly deliveredAgents = new Set<string>();

  constructor(private readonly deliver: (notice: TaskNotice) => void) {}

  jobFinished(job: JobInfo, project: string | null): void {
    if (!project || (job.kind !== 'review' && job.kind !== 'animatic') || (job.status !== 'done' && job.status !== 'failed')) return;
    if (this.deliveredJobs.has(job.id)) return;
    this.deliveredJobs.add(job.id);

    // Режимы из checks.ts и animatic.ts завершают рецепт или проверку входов без сборки MP4.
    const operation =
      job.kind === 'review'
        ? job.title.endsWith(' (только рецепт)')
          ? 'Рецепт пробы'
          : 'Проба'
        : job.title === 'Проверка входов аниматика'
          ? 'Проверка входов аниматика'
          : 'Аниматик';
    const success = job.status === 'done';
    const title = success
      ? operation === 'Проверка входов аниматика'
        ? 'Входы аниматика проверены'
        : `${operation} готов${operation === 'Проба' ? 'а' : ''}`
      : `Ошибка: ${job.title}`;
    this.send({ title, body: job.title, target: { project, route: job.kind === 'review' ? '/project/checks' : '/project/animatic' } });
  }

  agentEvent(event: AgentEvent): void {
    const job = event.job;
    if ((event.type !== 'completed' && event.type !== 'failed') || !job || (job.status !== 'completed' && job.status !== 'failed')) return;
    if (this.deliveredAgents.has(job.id)) return;
    this.deliveredAgents.add(job.id);

    // Завершение ответа не подтверждает корректность предложения и не заменяет согласование пользователем.
    const provider = job.provider === 'claude' ? 'Claude Code' : 'Codex';
    this.send({
      title: job.status === 'completed' ? `Ответ ${provider} готов` : `Ошибка ${provider}`,
      body: job.task,
      target: { project: job.project, route: job.task.startsWith('ai-clip-scenario:') ? '/project/scenario' : '/project/production' }
    });
  }

  timingFinished(project: string, success: boolean): void {
    this.send({
      title: success ? 'Черновик разметки готов' : 'Ошибка разметки',
      body: success ? 'Откройте разметку для проверки черновика.' : 'Не удалось подготовить черновик разметки. Вернитесь на страницу «Тайминги».',
      target: { project, route: '/project/timing' }
    });
  }

  private send(notice: TaskNotice): void {
    try {
      this.deliver(notice);
    } catch (error) {
      // Недоступность системных уведомлений не должна менять результат производственного задания.
      console.warn('Не удалось показать системное уведомление:', error);
    }
  }
}
