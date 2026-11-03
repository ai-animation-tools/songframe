import { scenarioTexts } from '@shared/texts/scenario';
import type { ScenarioProposal } from '@shared/scenario-workflow';

export interface WorkflowNotice {
  message: string;
  severity: 'success' | 'info' | 'warning' | 'error';
}

type ProposalState = Pick<ScenarioProposal, 'id' | 'status' | 'message'>;

/** Сообщает только о завершении задания, которое этот экран видел выполняющимся: открытие страницы с готовым предложением молчит. */
export function proposalNotice(previous: ProposalState | null | undefined, next: ProposalState | null | undefined): WorkflowNotice | null {
  if (!previous || !next || previous.id !== next.id || previous.status !== 'running' || next.status === 'running') return null;
  if (next.status === 'ready') return { message: next.message || scenarioTexts.notice.proposalReady, severity: 'success' };
  if (next.status === 'applied') return null;
  // Пользователь сам нажал «Остановить»: это подтверждение, а не ошибка.
  if (next.status === 'cancelled') return { message: scenarioTexts.notice.agentCancelled, severity: 'info' };
  return {
    message: next.message || (next.status === 'interrupted' ? scenarioTexts.notice.agentInterrupted : scenarioTexts.notice.agentFailed),
    severity: next.status === 'interrupted' ? 'warning' : 'error'
  };
}
