import type { ScenarioProposal } from '@shared/scenario-workflow';

export interface WorkflowNotice {
  message: string;
  severity: 'success' | 'warning' | 'error';
}

type ProposalState = Pick<ScenarioProposal, 'id' | 'status' | 'message'>;

/** Сообщает только о завершении задания, которое этот экран видел выполняющимся: открытие страницы с готовым предложением молчит. */
export function proposalNotice(previous: ProposalState | null | undefined, next: ProposalState | null | undefined): WorkflowNotice | null {
  if (!previous || !next || previous.id !== next.id || previous.status !== 'running' || next.status === 'running') return null;
  if (next.status === 'ready')
    return { message: next.message || 'Предложение агента готово: просмотрите сравнение и примените результат.', severity: 'success' };
  if (next.status === 'applied') return null;
  return {
    message: next.message || (next.status === 'interrupted' ? 'Задание агента прервано.' : 'Агент не подготовил предложение.'),
    severity: next.status === 'interrupted' ? 'warning' : 'error'
  };
}
