/** Явный выбор исполнителя проверяется до диагностики; доступность программы и вход подтверждаются отдельно. */
import type { AgentCheckResult, AgentSettings } from '@shared/agents';
import { aiActionProblem, type AiAccess, type AiActionKind, type AiExecutorAccess } from '@shared/ai-access';
import { COVER_AGENT_REQUIRED } from '@shared/cover-generation';
import { isMediaProvider, type MediaKind, type MediaProviderId } from '@shared/media-providers';
import { createAgentAdapter } from './agent-adapters';
import { readProjectSettings } from './checks';
import type { KlingAuth } from './kling-auth';
import type { SettingsStore } from './settings';

interface Options {
  settings(): SettingsStore;
  checkAgent?(config: AgentSettings): Promise<AgentCheckResult>;
  checkKling(): Promise<KlingAuth>;
}
const mediaMessage = (kind: MediaKind): string => `Сначала выберите провайдера ${kind === 'image' ? 'изображений' : 'видео'} в настройках проекта.`;
const blocked = (message: string): AiExecutorAccess & { provider: null } => ({ provider: null, selected: false, available: false, message });

interface Availability {
  available: boolean;
  message: string;
}

/** Выбор агента и провайдеров медиа независимы: агент нужен текстовым этапам, медиа — только собственный провайдер. */
function selection(settings: SettingsStore, project: string | null): AiAccess {
  const agent = settings.getAgent();
  const access: AiAccess = {
    agent: agent
      ? { provider: agent.provider, selected: true, available: false, message: 'Доступность агента ещё не проверена.' }
      : blocked(COVER_AGENT_REQUIRED),
    image: blocked(mediaMessage('image')),
    video: blocked(mediaMessage('video'))
  };
  if (!project) return access;
  const generation = readProjectSettings(project).generation;
  for (const kind of ['image', 'video'] as const) {
    const config = generation?.[kind];
    if (config?.provider_selected !== true) continue;
    access[kind] = {
      provider: config.provider,
      selected: true,
      available: false,
      message: isMediaProvider(config.provider, kind) ? 'Доступность провайдера ещё не проверена.' : 'Выбранный провайдер не поддерживается.'
    };
  }
  return access;
}

/** Синхронный запрет не позволяет создать временные файлы или начать подготовку из сохранённых defaults. */
export function assertAiSelection(settings: SettingsStore, project: string | null, kind: AiActionKind): void {
  const access = selection(settings, project);
  if (kind === 'agent') {
    if (!access.agent.selected) throw new Error(access.agent.message);
    return;
  }
  if (!access[kind].selected) throw new Error(access[kind].message);
}

export function createAiAccess(options: Options) {
  const diagnose = options.checkAgent ?? ((config: AgentSettings) => createAgentAdapter(config.provider).check(config));
  const getAccess = async (project: string | null, requiredKind?: AiActionKind): Promise<AiAccess> => {
    let access: AiAccess;
    try {
      access = selection(options.settings(), project);
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Не удалось прочитать настройки ИИ.';
      return { agent: { ...blocked(message), provider: null }, image: blocked(message), video: blocked(message) };
    }
    const checks = new Map<string, Promise<AgentCheckResult>>();
    const check = (config: AgentSettings): Promise<AgentCheckResult> => {
      const key = JSON.stringify(config);
      if (!checks.has(key)) checks.set(key, diagnose(config));
      return checks.get(key)!;
    };
    const agentAvailability = async (config: AgentSettings): Promise<Availability> => {
      const result = await check(config);
      return { available: result.availability === 'available' && result.authorization === 'authenticated', message: result.message };
    };
    let kling: Promise<KlingAuth> | undefined;
    // Record требует проверки доступности для каждого провайдера медиа из реестра.
    const mediaAvailability: Record<MediaProviderId, () => Promise<Availability>> = {
      codex: () => agentAvailability(options.settings().getImageAgent()),
      kling: async () => {
        kling ??= options.checkKling();
        const result = await kling;
        const available = result.status === 'authenticated';
        return { available, message: result.message || (available ? 'Вход в Kling подтверждён.' : 'Выполните вход в Kling в настройках приложения.') };
      }
    };
    const agentConfig = options.settings().getAgent();
    if (access.agent.selected && agentConfig && (!requiredKind || requiredKind === 'agent')) {
      try {
        Object.assign(access.agent, await agentAvailability(agentConfig));
      } catch (error) {
        access.agent.message = error instanceof Error ? error.message : 'Не удалось проверить доступность агента.';
      }
    }
    for (const kind of ['image', 'video'] as const) {
      const executor = access[kind];
      if (!executor.selected || !isMediaProvider(executor.provider, kind)) continue;
      if (requiredKind && requiredKind !== kind) continue;
      try {
        Object.assign(executor, await mediaAvailability[executor.provider]());
      } catch (error) {
        executor.message = error instanceof Error ? error.message : 'Не удалось проверить доступность провайдера.';
      }
    }
    return access;
  };
  const fingerprint = (project: string | null): string =>
    JSON.stringify({ agent: options.settings().getAgent(), generation: project ? readProjectSettings(project).generation : null });
  const requireAccess = async (project: string | null, kind: AiActionKind): Promise<void> => {
    assertAiSelection(options.settings(), project, kind);
    const before = fingerprint(project);
    const access = await getAccess(project, kind);
    // Асинхронная диагностика не сохраняет разрешение после отключения или замены исполнителя.
    assertAiSelection(options.settings(), project, kind);
    if (before !== fingerprint(project)) throw new Error('Настройки ИИ изменились во время проверки. Повторите действие.');
    const problem = aiActionProblem(access, kind);
    if (problem) throw new Error(problem);
  };
  return { getAccess, requireAccess };
}
