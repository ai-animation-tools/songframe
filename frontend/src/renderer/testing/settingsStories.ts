/**
 * Локальная модель группы agents для страницы настроек: сохранённый агент, профили CLI, диагностика,
 * аккаунт и каталог моделей. Настоящие CLI, профиль пользователя и сеть не вызываются; состояние живёт
 * в замыкании одной истории и пересоздаётся при её повторном открытии.
 */
import type { AgentAccountResult, AgentCheckResult, AgentModelsResult, AgentSettings } from '@shared/agents';
import type { AgentProvider } from '@shared/agent-providers';
import type { ApiOverrides } from './storybook';

export interface SettingsStoryModel {
  /** Сохранённый выбор агента; null — «Без агента». */
  agent: AgentSettings | null;
  /** Сохранённые профили CLI: модель одного агента не переносится на другой. */
  profiles?: Partial<Record<AgentProvider, AgentSettings>>;
  /** Агенты, не найденные на компьютере: их нельзя выбрать в форме. */
  missing?: AgentProvider[];
  /** Агенты без входа: проверка и аккаунт показывают «Вход не выполнен». */
  unauthenticated?: AgentProvider[];
}

const STORY_CHECKED_AT = '2026-11-04T09:30:00.000Z';
/** Время сброса лимита в секундах Unix, как его отдаёт CLI. */
const STORY_RESETS_AT = Date.parse('2026-11-04T14:00:00.000Z') / 1000;

export const SETTINGS_STORY_EMAIL = 'story-user@example.invalid';

function storyCheck(model: SettingsStoryModel, provider: AgentProvider): AgentCheckResult {
  if (model.missing?.includes(provider))
    return { availability: 'not_found', authorization: 'unknown', message: 'Программа агента не найдена в модели истории.' };
  const authenticated = !model.unauthenticated?.includes(provider);
  return {
    executablePath: `/mock/bin/${provider}`,
    version: provider === 'codex' ? 'codex-cli 0.160.0' : '2.1.5 (Claude Code)',
    availability: 'available',
    authorization: authenticated ? 'authenticated' : 'unauthenticated',
    message: authenticated ? 'Вход подтверждён в модели истории.' : 'Войдите в агента в модели истории.'
  };
}

function storyAccount(model: SettingsStoryModel, provider: AgentProvider): AgentAccountResult {
  const diagnostic = storyCheck(model, provider);
  const ready = diagnostic.availability === 'available' && diagnostic.authorization === 'authenticated';
  return {
    provider,
    checkedAt: STORY_CHECKED_AT,
    diagnostic,
    email: ready ? SETTINGS_STORY_EMAIL : null,
    organization: null,
    authenticationMethod: ready ? 'ChatGPT' : null,
    plan: ready ? 'Plus' : null,
    subscriptionStatus: null,
    subscriptionExpiresAt: null,
    limits: ready
      ? [
          { label: '5 ч', usedPercent: 42, windowMinutes: 300, resetsAt: STORY_RESETS_AT },
          { label: 'Неделя', usedPercent: 91, windowMinutes: 10080, resetsAt: null }
        ]
      : null,
    usageAllowed: null,
    credits: null
  };
}

function storyModels(model: SettingsStoryModel, provider: AgentProvider): AgentModelsResult {
  if (model.missing?.includes(provider)) return { models: [], message: 'Каталог моделей недоступен: агент не найден.' };
  return provider === 'codex'
    ? {
        models: [
          { id: 'gpt-5.5', label: 'GPT-5.5', isDefault: true },
          { id: 'gpt-5.5-mini', label: 'GPT-5.5 mini', description: 'Быстрее и дешевле' }
        ]
      }
    : {
        models: [
          { id: 'sonnet', label: 'Sonnet', isDefault: true },
          { id: 'opus', label: 'Opus' }
        ]
      };
}

/** Типизированные переопределения agents: сохранение меняет модель так же, как settings.json в Go. */
export function settingsStoryApi(initial: SettingsStoryModel): ApiOverrides {
  const model: SettingsStoryModel = { ...initial, profiles: { ...initial.profiles } };
  return {
    agents: {
      getSettings: async () => model.agent,
      getProviderSettings: async (provider) => model.profiles?.[provider] ?? null,
      saveProviderSettings: async (settings) => {
        model.profiles = { ...model.profiles, [settings.provider]: settings };
        if (model.agent?.provider === settings.provider) model.agent = settings;
        return settings;
      },
      saveSettings: async (settings) => {
        model.agent = settings;
        if (settings) model.profiles = { ...model.profiles, [settings.provider]: settings };
        return settings;
      },
      check: async (settings) => storyCheck(model, settings.provider),
      account: async (settings) => storyAccount(model, settings.provider),
      models: async (settings) => storyModels(model, settings.provider),
      list: async () => []
    }
  };
}
