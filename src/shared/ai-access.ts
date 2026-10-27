import type { AgentSettings } from './agents';

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

export function aiActionProblem(access: AiAccess | null | undefined, kind: AiActionKind = 'agent'): string | null {
  if (!access) return 'Проверяем выбор и доступность исполнителей ИИ…';
  if (!access.agent.selected || !access.agent.available) return access.agent.message || 'Сначала выберите доступного агента в настройках приложения.';
  if (kind !== 'agent' && (!access[kind].selected || !access[kind].available))
    return access[kind].message || `Сначала выберите доступного провайдера ${kind === 'image' ? 'изображений' : 'видео'} в настройках проекта.`;
  return null;
}
