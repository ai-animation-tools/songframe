import type { AgentSettings } from './agents';
import { aiAccessTexts } from './texts/ai-access';

/** Выбор пользователя и доступность исполнителя — отдельные условия запуска. */
export interface AiExecutorAccess {
  provider: string | null;
  selected: boolean;
  available: boolean;
  message: string;
}

export interface AiAccess {
  agent: AiExecutorAccess & { provider: AgentSettings['provider'] | null };
  image: AiExecutorAccess;
  video: AiExecutorAccess;
}

export type AiActionKind = 'agent' | 'image' | 'video';

/** Текстовые этапы требуют агента; генерация медиа — только своего провайдера, выбранный агент на неё не влияет. */
export function aiActionProblem(access: AiAccess | null | undefined, kind: AiActionKind = 'agent'): string | null {
  if (!access) return aiAccessTexts.checking;
  if (kind === 'agent') {
    if (!access.agent.selected || !access.agent.available) return access.agent.message || aiAccessTexts.availableAgentRequired;
    return null;
  }
  if (!access[kind].selected || !access[kind].available) return access[kind].message || aiAccessTexts.mediaProviderRequired({ kind });
  return null;
}
