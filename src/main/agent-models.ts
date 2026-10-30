/** Каталог моделей выбранного CLI для настроек; недоступный каталог не мешает ввести модель вручную. */
import { homedir } from 'node:os';
import { settingsTexts } from '@shared/texts/settings';
import type { AgentModelsResult, AgentSettings } from '@shared/agents';
import { agentTitle } from '@shared/agent-providers';
import type { AgentAdapter } from './agent-adapters';
import { agentEnvironment } from './agents';

export interface AgentModelsOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  timeoutMs?: number;
}

export async function readAgentModels(adapter: AgentAdapter, config: AgentSettings, options: AgentModelsOptions = {}): Promise<AgentModelsResult> {
  const check = await adapter.check(config);
  if (check.availability !== 'available' || !check.executablePath) return { models: [], message: check.message };
  const home = options.home ?? homedir();
  try {
    const models = await adapter.models(check.executablePath, { ...options, home, env: agentEnvironment(options.env, home) });
    return models.length ? { models } : { models: [], message: settingsTexts.main.modelsEmpty(agentTitle(config.provider)) };
  } catch {
    return { models: [], message: settingsTexts.main.modelsUnavailable(agentTitle(config.provider)) };
  }
}
