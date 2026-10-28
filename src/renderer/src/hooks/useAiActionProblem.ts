/** Общая причина недоступности AI-действия: кнопки и текстовые сводки доступности не должны расходиться. */
import { aiActionProblem, type AiActionKind } from '@shared/ai-access';
import { useApp } from '../state';

export function useAiActionProblem(aiKind: AiActionKind = 'agent'): string | null {
  const { agentProvider, aiAccess } = useApp();
  return aiKind === 'agent' && !agentProvider ? 'Сначала выберите агента в настройках приложения.' : aiActionProblem(aiAccess, aiKind);
}
