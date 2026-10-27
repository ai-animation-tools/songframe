/** Читает штатную диагностику Claude через control protocol, не создавая пользовательский ход. */
import { withAccountProcess, type AccountProcessOptions } from './codex-account-transport';

export interface ClaudeUsageWindow {
  utilization: number | null;
  resets_at: string | null;
}

export interface ClaudeUsageSnapshot {
  subscription_type: string | null;
  rate_limits_available: boolean | null;
  rate_limits: {
    five_hour?: ClaudeUsageWindow;
    seven_day?: ClaudeUsageWindow;
    seven_day_opus?: ClaudeUsageWindow;
    seven_day_sonnet?: ClaudeUsageWindow;
    limits?: Array<{
      kind: string;
      group: string;
      percent: number | null;
      severity: string | null;
      resets_at: string | null;
      is_active: boolean | null;
    }>;
  } | null;
}

function object(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

function percent(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 && value <= 100 ? value : null;
}

function resetTime(value: unknown): string | null {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}T/.test(value) && value.length <= 40 && Number.isFinite(Date.parse(value)) ? value : null;
}

function identifier(value: unknown): string | null {
  return typeof value === 'string' && /^[a-z][a-z0-9_]{0,63}$/.test(value) ? value : null;
}

/** Список полей намеренно узкий: аккаунт, произвольный текст CLI и история сеансов наружу не выходят. */
function usageSnapshot(value: unknown): ClaudeUsageSnapshot | null {
  const data = object(value);
  if (!data || (!('rate_limits_available' in data) && !('rate_limits' in data))) return null;
  const rateLimits = object(data.rate_limits);
  const rates: NonNullable<ClaudeUsageSnapshot['rate_limits']> = {};
  if (rateLimits) {
    for (const key of ['five_hour', 'seven_day', 'seven_day_opus', 'seven_day_sonnet'] as const) {
      const window = object(rateLimits[key]);
      if (window) rates[key] = { utilization: percent(window.utilization), resets_at: resetTime(window.resets_at) };
    }
    if (Array.isArray(rateLimits.limits)) {
      rates.limits = rateLimits.limits.slice(0, 32).flatMap((value) => {
        const row = object(value);
        const kind = identifier(row?.kind);
        const group = identifier(row?.group);
        if (!row || !kind || !group) return [];
        return [
          {
            kind,
            group,
            percent: percent(row.percent),
            severity: identifier(row.severity),
            resets_at: resetTime(row.resets_at),
            is_active: typeof row.is_active === 'boolean' ? row.is_active : null
          }
        ];
      });
    }
  }
  return {
    subscription_type:
      typeof data.subscription_type === 'string' && ['pro', 'max', 'team', 'enterprise'].includes(data.subscription_type) ? data.subscription_type : null,
    rate_limits_available: typeof data.rate_limits_available === 'boolean' ? data.rate_limits_available : null,
    rate_limits: rateLimits ? rates : null
  };
}

export async function readClaudeUsage(executable: string, options: AccountProcessOptions): Promise<ClaudeUsageSnapshot | null> {
  try {
    return await withAccountProcess(
      executable,
      [
        '--output-format',
        'stream-json',
        '--verbose',
        '--input-format',
        'stream-json',
        '--setting-sources=',
        '--strict-mcp-config',
        '--mcp-config',
        '{"mcpServers":{}}',
        '--tools',
        '',
        '--no-session-persistence',
        '--settings',
        '{"disableAllHooks":true}'
      ],
      options,
      async (child, closed) =>
        new Promise<ClaudeUsageSnapshot | null>((resolve, reject) => {
          let buffer = '';
          let waiting: 'initialize' | 'get_usage' = 'initialize';
          let finished = false;
          const fail = (): void => {
            if (finished) return;
            finished = true;
            reject(new Error('Не удалось прочитать лимиты Claude.'));
          };
          const send = (): void => {
            // get_usage — экспериментальный метод SDK; skip_behaviors исключает чтение истории за семь дней.
            child.stdin.write(
              `${JSON.stringify({ type: 'control_request', request_id: waiting, request: waiting === 'initialize' ? { subtype: 'initialize' } : { subtype: 'get_usage', skip_behaviors: true } })}\n`
            );
          };
          void closed.then(fail);
          child.stdout.setEncoding('utf8');
          child.stdout.on('data', (chunk: string) => {
            if (finished) return;
            buffer += chunk;
            let newline: number;
            while (!finished && (newline = buffer.indexOf('\n')) >= 0) {
              const line = buffer.slice(0, newline).trim();
              buffer = buffer.slice(newline + 1);
              if (!line) continue;
              try {
                const message = object(JSON.parse(line));
                if (!message) {
                  fail();
                  return;
                }
                // Допустимы служебные уведомления, но не неожиданный ход модели или запрос инструмента.
                if (message.type === 'system') continue;
                if (message.type !== 'control_response') {
                  fail();
                  return;
                }
                const response = object(message.response);
                if (!response || response.request_id !== waiting || response.subtype !== 'success') {
                  fail();
                  return;
                }
                if (waiting === 'initialize') {
                  waiting = 'get_usage';
                  send();
                } else {
                  finished = true;
                  resolve(usageSnapshot(response.response));
                }
              } catch {
                fail();
              }
            }
          });
          send();
        })
    );
  } catch {
    return null;
  }
}
