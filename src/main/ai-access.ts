/** Явный выбор исполнителя проверяется до диагностики; доступность CLI и вход подтверждаются отдельно. */
import type { AgentCheckResult, AgentSettings } from '@shared/agents';
import { aiActionProblem, type AiAccess, type AiActionKind, type AiExecutorAccess } from '@shared/ai-access';
import { COVER_AGENT_REQUIRED } from '@shared/cover-generation';
import { createAgentAdapter } from './agent-adapters';
import { readProjectSettings } from './checks';
import type { KlingAuth } from './kling-auth';
import type { SettingsStore } from './settings';

interface Options {
  settings(): SettingsStore;
  checkAgent?(config: AgentSettings): Promise<AgentCheckResult>;
  checkKling(): Promise<KlingAuth>;
}
const mediaMessage = (kind: 'image' | 'video'): string => `Сначала выберите провайдера ${kind === 'image' ? 'изображений' : 'видео'} в настройках проекта.`;
const codexAgentMessage = 'Для изображений Codex выберите агента Codex в настройках приложения.';
const blocked = (message: string): AiExecutorAccess & { provider: null } => ({ provider: null, selected: false, available: false, message });

function selection(settings: SettingsStore, project: string | null): AiAccess {
  const agent = settings.getAgent();
  const access: AiAccess = {
    agent: agent
      ? { provider: agent.provider, selected: true, available: false, message: 'Доступность агента ещё не проверена.' }
      : blocked(COVER_AGENT_REQUIRED),
    image: blocked(mediaMessage('image')),
    video: blocked(mediaMessage('video'))
  };
  if (!agent || !project) return access;
  const generation = readProjectSettings(project).generation;
  for (const kind of ['image', 'video'] as const) {
    const config = generation?.[kind];
    if (config?.provider_selected !== true) continue;
    access[kind] = {
      provider: config.provider,
      selected: true,
      available: false,
      message:
        config.provider === 'kling' || (kind === 'image' && config.provider === 'codex')
          ? 'Доступность провайдера ещё не проверена.'
          : 'Выбранный провайдер не поддерживается.'
    };
    if (kind === 'image' && config.provider === 'codex' && agent.provider !== 'codex') access.image.message = codexAgentMessage;
  }
  return access;
}

/** Синхронный запрет не позволяет создать временные файлы или начать подготовку из сохранённых defaults. */
export function assertAiSelection(settings: SettingsStore, project: string | null, kind: AiActionKind): void {
  const access = selection(settings, project);
  if (!access.agent.selected) throw new Error(access.agent.message);
  if (kind !== 'agent' && !access[kind].selected) throw new Error(access[kind].message);
  if (kind === 'image' && access.image.provider === 'codex' && access.agent.provider !== 'codex') throw new Error(codexAgentMessage);
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
    if (!access.agent.selected) return access;
    const checks = new Map<string, Promise<AgentCheckResult>>();
    const check = (config: AgentSettings): Promise<AgentCheckResult> => {
      const key = JSON.stringify(config);
      if (!checks.has(key)) checks.set(key, diagnose(config));
      return checks.get(key)!;
    };
    try {
      const result = await check(options.settings().getAgent()!);
      access.agent.available = result.availability === 'available' && result.authorization === 'authenticated';
      access.agent.message = result.message;
    } catch (error) {
      access.agent.message = error instanceof Error ? error.message : 'Не удалось проверить доступность агента.';
    }
    if (!access.agent.available) return access;
    if (!options.settings().getAgent()) return selection(options.settings(), project);
    let kling: Promise<KlingAuth> | undefined;
    for (const kind of ['image', 'video'] as const) {
      const executor = access[kind];
      if (!executor.selected) continue;
      if (requiredKind && requiredKind !== kind) continue;
      if (kind === 'image' && executor.provider === 'codex' && options.settings().getAgent()?.provider !== 'codex') {
        executor.message = codexAgentMessage;
        continue;
      }
      try {
        if (executor.provider === 'codex' && kind === 'image') {
          const result = await check(options.settings().getImageAgent());
          executor.available = result.availability === 'available' && result.authorization === 'authenticated';
          executor.message = result.message;
        } else if (executor.provider === 'kling') {
          kling ??= options.checkKling();
          const result = await kling;
          executor.available = result.status === 'authenticated';
          executor.message = result.message || (executor.available ? 'Вход в Kling подтверждён.' : 'Выполните вход в Kling в настройках приложения.');
        }
      } catch (error) {
        executor.message = error instanceof Error ? error.message : 'Не удалось проверить доступность провайдера.';
      }
    }
    return access;
  };
  const fingerprint = (project: string | null): string => {
    const agent = options.settings().getAgent();
    const generation = project ? readProjectSettings(project).generation : null;
    return JSON.stringify({
      agent,
      imageAgent:
        agent?.provider === 'codex' && generation?.image?.provider_selected && generation.image.provider === 'codex'
          ? options.settings().getImageAgent()
          : null,
      generation
    });
  };
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
