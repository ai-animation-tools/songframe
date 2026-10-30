import type { AgentEvent } from '@shared/agents';
import { agentTitle } from '@shared/agent-providers';
import type { NotificationTarget } from '@shared/notifications';
import { checksTexts } from '@shared/texts/checks';
import { notificationsTexts } from '@shared/texts/notifications';
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

    // Режимы проверки из checks.ts и animatic.ts завершаются без сборки MP4.
    const operation =
      job.kind === 'review'
        ? job.title.endsWith(checksTexts.reviewPlanOnlySuffix)
          ? notificationsTexts.reviewCheckOperation
          : notificationsTexts.reviewOperation
        : job.title === notificationsTexts.animaticCheckTitle
          ? notificationsTexts.animaticCheckTitle
          : notificationsTexts.animaticOperation;
    const success = job.status === 'done';
    const title = success
      ? operation === notificationsTexts.animaticCheckTitle
        ? notificationsTexts.animaticInputsChecked
        : operation === notificationsTexts.reviewCheckOperation
          ? notificationsTexts.reviewChecked
          : notificationsTexts.operationReady(operation)
      : notificationsTexts.jobFailed(job.title);
    this.send({ title, body: job.title, target: { project, route: job.kind === 'review' ? '/project/checks' : '/project/animatic' } });
  }

  agentEvent(event: AgentEvent): void {
    const job = event.job;
    if ((event.type !== 'completed' && event.type !== 'failed') || !job || (job.status !== 'completed' && job.status !== 'failed')) return;
    if (this.deliveredAgents.has(job.id)) return;
    this.deliveredAgents.add(job.id);

    // Завершение ответа не подтверждает корректность предложения и не заменяет согласование пользователем.
    const provider = agentTitle(job.provider);
    this.send({
      title: job.status === 'completed' ? notificationsTexts.agentCompleted(provider) : notificationsTexts.agentFailed(provider),
      body: job.task,
      target: { project: job.project, route: job.task.startsWith('ai-clip-scenario:') ? '/project/scenario' : '/project/production' }
    });
  }

  timingFinished(project: string, success: boolean): void {
    this.send({
      title: success ? notificationsTexts.timingCompletedTitle : notificationsTexts.timingFailedTitle,
      body: success ? notificationsTexts.timingCompletedBody : notificationsTexts.timingFailedBody,
      target: { project, route: '/project/timing' }
    });
  }

  private send(notice: TaskNotice): void {
    try {
      this.deliver(notice);
    } catch (error) {
      // Недоступность системных уведомлений не должна менять результат производственного задания.
      // eslint-disable-next-line no-restricted-syntax -- Сообщение журнала остаётся у адаптера доставки и не относится к текстам интерфейса.
      console.warn('Не удалось показать системное уведомление:', error);
    }
  }
}
