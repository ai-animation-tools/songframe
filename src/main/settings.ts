/** Настройки лежат рядом с историей и журналами, включая явно выбранный SONGFRAME_LOCAL_DIR. */
import { isAbsolute, join } from 'node:path';
import type { AgentSettings } from '@shared/agents';
import { agentTitle, isAgentProvider, type AgentProvider } from '@shared/agent-providers';
import { readLocalJson, writeLocalJson } from './local-files';

export interface Settings {
  toolsRootOverride?: string | null;
  agent?: AgentSettings;
  imageAgent?: AgentSettings;
  agentProfiles?: Partial<Record<AgentProvider, AgentSettings>>;
}

export function normalizeAgentSettings(value: unknown): AgentSettings | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Неверный формат настроек агента.');
  const input = value as Record<string, unknown>;
  if (!isAgentProvider(input.provider)) throw new Error(`Выберите ${agentTitle(null)}.`);
  const optionalText = (key: string): string | undefined => {
    if (input[key] === undefined) return undefined;
    if (typeof input[key] !== 'string' || input[key].includes('\0')) throw new Error('Модель и путь должны быть текстом без нулевых символов.');
    return input[key].trim() || undefined;
  };
  const executablePath = optionalText('executablePath');
  const model = optionalText('model');
  if (executablePath && !isAbsolute(executablePath)) throw new Error('Укажите абсолютный путь к CLI или оставьте поле пустым для поиска.');
  return { provider: input.provider, ...(executablePath ? { executablePath } : {}), ...(model ? { model } : {}) };
}

function profiles(value: unknown): Partial<Record<AgentProvider, AgentSettings>> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Неверный формат профилей CLI.');
  const result: Partial<Record<AgentProvider, AgentSettings>> = {};
  for (const [provider, input] of Object.entries(value)) {
    if (!isAgentProvider(provider)) throw new Error('Неизвестный провайдер CLI.');
    const normalized = normalizeAgentSettings(input);
    if (!normalized || normalized.provider !== provider) throw new Error('Провайдер профиля CLI не совпадает с его именем.');
    result[provider] = normalized;
  }
  return result;
}

export class SettingsStore {
  constructor(readonly localDir: string) {}
  private get file(): string {
    return join(this.localDir, 'settings.json');
  }

  read(): Settings {
    const value = readLocalJson<Settings>(this.file);
    if (value === null) return {};
    if (
      typeof value !== 'object' ||
      Array.isArray(value) ||
      (value.toolsRootOverride !== undefined && value.toolsRootOverride !== null && typeof value.toolsRootOverride !== 'string')
    ) {
      throw new Error(`Неверный формат ${this.file}. Настройки сохранены; исправьте файл или перенесите его в резервную папку.`);
    }
    try {
      // Старый файл без agent остаётся рабочим: выбор провайдера не появляется неявно.
      const agent = normalizeAgentSettings(value.agent);
      const agentProfiles = profiles(value.agentProfiles);
      const imageAgent = normalizeAgentSettings(value.imageAgent);
      if (imageAgent && imageAgent.provider !== 'codex') throw new Error('Для опор нужен профиль Codex.');
      return { ...value, ...(agent ? { agent } : {}), ...(value.agentProfiles ? { agentProfiles } : {}), ...(imageAgent ? { imageAgent } : {}) };
    } catch {
      throw new Error(`Неверный формат агента в ${this.file}. Настройки сохранены; исправьте файл или перенесите его в резервную папку.`);
    }
  }

  write(value: Settings): void {
    const merged = { ...this.read(), ...value };
    const agent = normalizeAgentSettings(merged.agent);
    if (agent) merged.agent = agent;
    else delete merged.agent;
    if (merged.agentProfiles) merged.agentProfiles = profiles(merged.agentProfiles);
    if (merged.imageAgent) {
      const imageAgent = normalizeAgentSettings(merged.imageAgent);
      if (!imageAgent || imageAgent.provider !== 'codex') throw new Error('Для опор нужен профиль Codex.');
      merged.imageAgent = imageAgent;
    }
    writeLocalJson(this.file, merged);
  }

  /** Путь и модель другого CLI не переносятся при смене исполнителя или создании опор. */
  getProviderAgent(provider: AgentProvider): AgentSettings | null {
    if (!isAgentProvider(provider)) throw new Error('Неизвестный провайдер CLI.');
    const saved = this.read();
    return saved.agent?.provider === provider ? saved.agent : (saved.agentProfiles?.[provider] ?? null);
  }

  saveProviderAgent(value: unknown): AgentSettings {
    const agent = normalizeAgentSettings(value);
    if (!agent) throw new Error('Укажите профиль CLI.');
    const saved = this.read();
    this.write({ agentProfiles: { ...saved.agentProfiles, [agent.provider]: agent }, ...(saved.agent?.provider === agent.provider ? { agent } : {}) });
    return agent;
  }

  getImageAgent(): AgentSettings {
    return this.read().imageAgent ?? this.getProviderAgent('codex') ?? { provider: 'codex' };
  }

  /** Профиль изображения не меняет модель текстового Codex даже при выборе того же CLI. */
  saveImageAgent(value: unknown): AgentSettings {
    const agent = normalizeAgentSettings(value);
    if (!agent || agent.provider !== 'codex') throw new Error('Для опор выберите Codex.');
    this.write({ imageAgent: agent });
    return agent;
  }

  getAgent(): AgentSettings | null {
    return this.read().agent ?? null;
  }

  saveAgent(value: unknown): AgentSettings | null {
    const agent = normalizeAgentSettings(value);
    // Обновляется только блок агента; выбор ресурсов и остальные поля файла сохраняются.
    const saved = this.read();
    this.write({ agent: agent ?? undefined, ...(agent ? { agentProfiles: { ...saved.agentProfiles, [agent.provider]: agent } } : {}) });
    return agent;
  }
}
