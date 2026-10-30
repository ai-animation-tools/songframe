import { providerTexts } from './texts/providers';
/** Реестр текстовых CLI-агентов: всё, что главному процессу и интерфейсу нужно знать о провайдере помимо его адаптера. */
export interface AgentProviderInfo {
  /** Название в интерфейсе и уведомлениях. */
  title: string;
  /** Имя исполняемого файла для автоматического поиска в PATH. */
  executable: string;
  /** Команды для пользователя: вход и ручная проверка в терминале. */
  loginCommand: string;
  statusCommand: string;
  /** Официальные инструкции установки и входа. */
  installUrl: string;
  loginUrl: string;
  /** Личный кабинет подписки: использование, лимиты и тариф. */
  accountUrl: string;
}

export const AGENT_PROVIDERS = {
  claude: {
    title: 'Claude Code',
    executable: 'claude',
    loginCommand: 'claude auth login',
    statusCommand: 'claude auth status',
    installUrl: 'https://code.claude.com/docs/en/setup',
    loginUrl: 'https://code.claude.com/docs/en/cli-reference',
    accountUrl: 'https://claude.ai/settings/usage'
  },
  codex: {
    title: 'Codex',
    executable: 'codex',
    loginCommand: 'codex login',
    statusCommand: 'codex login status',
    installUrl: 'https://learn.chatgpt.com/docs/codex/cli',
    loginUrl: 'https://learn.chatgpt.com/docs/developer-commands?surface=cli#codex-login',
    accountUrl: 'https://chatgpt.com/codex/settings/usage'
  }
} as const satisfies Record<string, AgentProviderInfo>;

export type AgentProvider = keyof typeof AGENT_PROVIDERS;

/** Порядок совпадает с порядком вариантов в настройках. */
export const AGENT_PROVIDER_IDS = Object.keys(AGENT_PROVIDERS) as AgentProvider[];

export function isAgentProvider(value: unknown): value is AgentProvider {
  return typeof value === 'string' && Object.hasOwn(AGENT_PROVIDERS, value);
}

/** Без выбранного провайдера перечисляются все подключённые агенты. */
export function agentTitle(provider: AgentProvider | null | undefined): string {
  return provider ? AGENT_PROVIDERS[provider].title : AGENT_PROVIDER_IDS.map((id) => AGENT_PROVIDERS[id].title).join(providerTexts.alternativeSeparator);
}
