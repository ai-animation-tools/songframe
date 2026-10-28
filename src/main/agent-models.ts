/** Каталог моделей выбранного CLI для настроек; недоступный каталог не мешает ввести модель вручную. */
import { homedir } from 'node:os';
import type { AgentModelsResult, AgentSettings } from '@shared/agents';
import { agentTitle } from '@shared/agent-providers';
import type { AgentAdapter } from './agent-adapters';
import { agentEnvironment } from './agents';

export interface AgentModelsOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  timeoutMs?: number;
}

const MANUAL = 'Модель можно ввести вручную.';

export async function readAgentModels(adapter: AgentAdapter, config: AgentSettings, options: AgentModelsOptions = {}): Promise<AgentModelsResult> {
  const check = await adapter.check(config);
  if (check.availability !== 'available' || !check.executablePath) return { models: [], message: check.message };
  const home = options.home ?? homedir();
  try {
    const models = await adapter.models(check.executablePath, { ...options, home, env: agentEnvironment(options.env, home) });
    return models.length ? { models } : { models: [], message: `${agentTitle(config.provider)} не вернул доступные модели. ${MANUAL}` };
  } catch {
    return { models: [], message: `Каталог моделей ${agentTitle(config.provider)} сейчас недоступен. ${MANUAL}` };
  }
}
