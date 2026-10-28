/** Снимок подтверждённых полей аккаунта: отсутствие ответа не означает нулевой лимит или оплаченную подписку. */
import { homedir } from 'node:os';
import type { AgentAccountLimit, AgentAccountResult, AgentSettings } from '@shared/agents';
import { agentEnvironment, checkAgent } from './agents';
import { readAccountCommand, readCodexAccount } from './codex-account-transport';
import { readClaudeUsage, type ClaudeUsageSnapshot } from './claude-account-transport';

export interface AgentAccountOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  timeoutMs?: number;
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}

function text(value: unknown): string | null {
  return typeof value === 'string' && value.trim()
    ? value
        .replace(/\p{Cc}/gu, '')
        .trim()
        .slice(0, 512) || null
    : null;
}

function number(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

function supported(version: string | undefined, major: number, minor: number): boolean {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version ?? '');
  return !!match && +match[1] === major && +match[2] >= minor;
}

async function prepare(config: AgentSettings, options: AgentAccountOptions): Promise<AgentAccountResult> {
  return {
    provider: config.provider,
    checkedAt: new Date().toISOString(),
    diagnostic: await checkAgent(config, options),
    email: null,
    organization: null,
    authenticationMethod: null,
    plan: null,
    subscriptionStatus: null,
    subscriptionExpiresAt: null,
    limits: null,
    usageAllowed: null,
    credits: null
  };
}

const PARTIAL_MESSAGE = 'Часть данных аккаунта недоступна в ответе агента. Проверьте подключение и актуальность его версии.';

export async function claudeAccount(config: AgentSettings, options: AgentAccountOptions = {}): Promise<AgentAccountResult> {
  const result = await prepare(config, options);
  const path = result.diagnostic.executablePath;
  if (!path || result.diagnostic.availability !== 'available') return result;
  if (!supported(result.diagnostic.version, 2, 1)) return { ...result, message: 'Данные аккаунта недоступны для этой версии Claude Code.' };
  if (result.diagnostic.authorization === 'unauthenticated') return result;
  const home = options.home ?? homedir();
  let canReadSubscriptionUsage = false;
  try {
    const response = object(await readAccountCommand(path, ['auth', 'status', '--json'], { ...options, home, env: agentEnvironment(options.env, home) }));
    if (response.loggedIn === true) {
      result.email = text(response.email);
      result.organization = text(response.orgName) ?? text(response.orgId);
      result.authenticationMethod = text(response.authMethod);
      result.plan = text(response.subscriptionType);
      // Изолированный control CLI не загружает apiKeyHelper: его личные лимиты нельзя приписывать рабочему API-аккаунту.
      canReadSubscriptionUsage =
        (response.authMethod === 'claude.ai' || response.authMethod === 'oauth_token') &&
        response.apiProvider === 'firstParty' &&
        (response.apiKeySource === undefined || response.apiKeySource === 'none');
    } else if (response.loggedIn !== false) result.message = PARTIAL_MESSAGE;
  } catch {
    result.message = PARTIAL_MESSAGE;
  }
  const version = /^(\d+)\.(\d+)\.(\d+)$/.exec(result.diagnostic.version ?? '');
  if (canReadSubscriptionUsage && version && (+version[2] > 1 || +version[3] >= 273)) {
    const usage = await readClaudeUsage(path, { ...options, home, env: agentEnvironment(options.env, home) });
    if (usage) {
      result.limits = claudeLimits(usage);
    } else result.message = PARTIAL_MESSAGE;
  }
  return result;
}

function claudeLimits(usage: ClaudeUsageSnapshot): AgentAccountLimit[] | null {
  if (usage.rate_limits_available === false || !usage.rate_limits) return null;
  const rates = usage.rate_limits;
  const reset = (value: string | null): number | null => (value === null ? null : Math.floor(Date.parse(value) / 1000));
  // Динамический список CLI учитывает отдельные модели и группы; фиксированные окна служат только старому формату.
  if (rates.limits) {
    const limits = rates.limits.flatMap((row): AgentAccountLimit[] =>
      row.percent === null
        ? []
        : [
            {
              label: `${row.group} · ${row.kind}`,
              usedPercent: row.percent,
              windowMinutes: row.kind === 'five_hour' ? 300 : row.kind.startsWith('seven_day') ? 10080 : null,
              resetsAt: reset(row.resets_at)
            }
          ]
    );
    return limits.length ? limits : null;
  }
  const limits: AgentAccountLimit[] = [];
  for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const) {
    const window = rates[key];
    if (!window || window.utilization === null) continue;
    const windowMinutes = key === 'five_hour' ? 300 : 10080;
    limits.push({ label: `${key} · ${windowMinutes} мин`, usedPercent: window.utilization, windowMinutes, resetsAt: reset(window.resets_at) });
  }
  return limits.length ? limits : null;
}

function codexLimits(response: Record<string, unknown>): Pick<AgentAccountResult, 'limits' | 'credits'> {
  // Многокорзинный ответ авторитетен даже при пустой карте: legacy не должен подменять его старыми числами.
  const buckets =
    response.rateLimitsByLimitId && typeof response.rateLimitsByLimitId === 'object' && !Array.isArray(response.rateLimitsByLimitId)
      ? Object.entries(response.rateLimitsByLimitId)
      : response.rateLimits && typeof response.rateLimits === 'object' && !Array.isArray(response.rateLimits)
        ? [[text(object(response.rateLimits).limitId) ?? 'codex', response.rateLimits] as const]
        : [];
  const limits: AgentAccountLimit[] = [];
  const creditBalances = new Set<string>();
  for (const [id, raw] of buckets) {
    const bucket = object(raw);
    const name = text(bucket.limitName) ?? text(bucket.limitId) ?? text(id) ?? 'codex';
    for (const key of ['primary', 'secondary'] as const) {
      const window = object(bucket[key]);
      const usedPercent = number(window.usedPercent);
      if (usedPercent === null || usedPercent > 100) continue;
      const windowMinutes = number(window.windowDurationMins);
      limits.push({
        label: `${name} · ${key}${windowMinutes === null ? '' : ` · ${windowMinutes} мин`}`,
        usedPercent,
        windowMinutes,
        resetsAt: number(window.resetsAt)
      });
    }
    const credits = object(bucket.credits);
    const balance = text(credits.balance);
    if (credits.unlimited === true) creditBalances.add('Без ограничений');
    else if (balance !== null) creditBalances.add(balance);
    else if (credits.hasCredits === false) creditBalances.add('Нет кредитов');
    else if (credits.hasCredits === true) creditBalances.add('Есть кредиты');
  }
  return { limits: limits.length ? limits : null, credits: creditBalances.size ? [...creditBalances].join('; ') : null };
}

export async function codexAccount(config: AgentSettings, options: AgentAccountOptions = {}): Promise<AgentAccountResult> {
  const result = await prepare(config, options);
  const path = result.diagnostic.executablePath;
  if (!path || result.diagnostic.availability !== 'available') return result;
  if (!supported(result.diagnostic.version, 0, 159)) return { ...result, message: 'Данные аккаунта недоступны для этой версии Codex.' };
  if (result.diagnostic.authorization === 'unauthenticated') return result;
  const home = options.home ?? homedir();
  const snapshot = await readCodexAccount(path, { ...options, home, env: agentEnvironment(options.env, home) });
  const accountResponse = object(snapshot.account);
  // login status подтверждает локальные учётные данные; явный ответ сервера об отсутствии аккаунта важнее этого кэша.
  if (accountResponse.account === null && accountResponse.requiresOpenaiAuth === true) {
    const message = 'Codex сообщает, что вход не выполнен. Выполните codex login в терминале.';
    return { ...result, diagnostic: { ...result.diagnostic, authorization: 'unauthenticated', message }, message };
  }
  const account = object(accountResponse.account);
  const method = text(account.type);
  if (method === 'chatgpt') {
    result.authenticationMethod = 'ChatGPT';
    result.email = text(account.email);
    result.plan = account.planType === 'unknown' ? null : text(account.planType);
  } else if (method === 'apiKey') result.authenticationMethod = 'API key';
  else if (method === 'amazonBedrock') result.authenticationMethod = 'Amazon Bedrock';
  else {
    result.diagnostic = { ...result.diagnostic, authorization: 'unknown', message: 'Не удалось подтвердить вход по ответу Codex.' };
    result.message = PARTIAL_MESSAGE;
  }
  Object.assign(result, codexLimits(object(snapshot.rateLimits)));
  const usageAllowed = object(snapshot.rateLimits).ordinaryUsageAllowed;
  result.usageAllowed = typeof usageAllowed === 'boolean' ? usageAllowed : null;
  if (usageAllowed === false) result.message = 'Codex сообщает об ограничении использования.';
  if (snapshot.partial || !snapshot.rateLimits || !snapshot.account) result.message = PARTIAL_MESSAGE;
  return result;
}
