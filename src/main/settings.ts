/** Настройки лежат рядом с историей и журналами, включая явно выбранный SONGFRAME_LOCAL_DIR. */
import { join } from 'node:path';
import type { AgentSettings } from '@shared/agents';
import { agentTitle, isAgentProvider, type AgentProvider } from '@shared/agent-providers';
import { mediaProviderInfo, type MediaProviderId } from '@shared/media-providers';
import { readLocalJson, writeLocalJson } from './local-files';

export interface Settings {
  toolsRootOverride?: string | null;
  agent?: AgentSettings;
  agentProfiles?: Partial<Record<AgentProvider, AgentSettings>>;
}

export function normalizeAgentSettings(value: unknown): AgentSettings | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'object' || Array.isArray(value)) throw new Error('Неверный формат настроек агента.');
  const input = value as Record<string, unknown>;
  if (!isAgentProvider(input.provider)) throw new Error(`Выберите ${agentTitle(null)}.`);
  if (input.model !== undefined && (typeof input.model !== 'string' || input.model.includes('\0')))
    throw new Error('Модель должна быть текстом без нулевых символов.');
  const model = input.model?.trim();
  return { provider: input.provider, ...(model ? { model } : {}) };
}

function profiles(value: unknown): Partial<Record<AgentProvider, AgentSettings>> {
  if (value === undefined) return {};
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Неверный формат профилей агентов.');
  const result: Partial<Record<AgentProvider, AgentSettings>> = {};
  for (const [provider, input] of Object.entries(value)) {
    if (!isAgentProvider(provider)) throw new Error('Неизвестный агент.');
    const normalized = normalizeAgentSettings(input);
    if (!normalized || normalized.provider !== provider) throw new Error('Агент профиля не совпадает с его именем.');
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
      return { ...value, ...(agent ? { agent } : {}), ...(value.agentProfiles ? { agentProfiles } : {}) };
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
    writeLocalJson(this.file, merged);
  }

  /** Модель другого CLI не переносится при смене исполнителя. */
  getProviderAgent(provider: AgentProvider): AgentSettings | null {
    if (!isAgentProvider(provider)) throw new Error('Неизвестный агент.');
    const saved = this.read();
    return saved.agent?.provider === provider ? saved.agent : (saved.agentProfiles?.[provider] ?? null);
  }

  saveProviderAgent(value: unknown): AgentSettings {
    const agent = normalizeAgentSettings(value);
    if (!agent) throw new Error('Укажите профиль агента.');
    const saved = this.read();
    this.write({ agentProfiles: { ...saved.agentProfiles, [agent.provider]: agent }, ...(saved.agent?.provider === agent.provider ? { agent } : {}) });
    return agent;
  }

  /**
   * Программа-агент провайдера изображений по реестру и модель из настроек проекта.
   * Модель текстового агента сюда не переносится: пустая модель оставляет выбор самой программе.
   */
  getImageAgent(provider: MediaProviderId, model?: string): AgentSettings {
    const executor = mediaProviderInfo(provider, 'image')?.executor;
    if (!executor) throw new Error('Выбранный провайдер изображений не исполняется программой-агентом.');
    const value = model?.trim();
    return { provider: executor, ...(value ? { model: value } : {}) };
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
