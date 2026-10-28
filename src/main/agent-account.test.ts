/** Подставные CLI проверяют чтение аккаунта и освобождение процессов без запросов к настоящим провайдерам. */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { claudeAccount, codexAccount } from './agent-account';
import { ClaudeAdapter, CodexAdapter } from './agent-adapters';

let home: string;
beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), 'Диагностика аккаунта '));
});
afterEach(() => {
  rmSync(home, { recursive: true, force: true });
});

const account = { account: { type: 'chatgpt', email: 'user@example.test', planType: 'plus' }, requiresOpenaiAuth: true };
const rates = { rateLimits: { primary: { usedPercent: 22, windowDurationMins: 300, resetsAt: 1_900_000_000 } } };
const options = (): { home: string; env: NodeJS.ProcessEnv; timeoutMs: number } => ({ home, env: { PATH: home, HOME: home }, timeoutMs: 1500 });

function calls(): unknown[] {
  return readFileSync(join(home, 'calls'), 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line));
}

function cli(provider: 'codex' | 'claude', body: string, status?: string, version?: string, usage: unknown = null): string {
  const path = join(home, '.local', 'bin', provider);
  mkdirSync(join(home, '.local', 'bin'), { recursive: true });
  writeFileSync(
    path,
    `#!${process.execPath}
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    const log = (data) => fs.appendFileSync(${JSON.stringify(join(home, 'calls'))}, JSON.stringify(data) + '\\n');
    log(args);
    if (JSON.stringify(args) === '["--version"]') {
      console.log(${JSON.stringify(version ?? (provider === 'codex' ? 'codex-cli 0.159.2' : '2.1.284 (Claude Code)'))});
    } else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json']))}) {
      ${status ?? (provider === 'codex' ? 'console.error("Logged in using ChatGPT");' : body)}
    } else if (${JSON.stringify(provider)} === 'claude' && args[0] === '--output-format') {
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const request=JSON.parse(line);log(request);
        console.log(JSON.stringify({type:'control_response',response:{subtype:'success',request_id:request.request_id,response:request.request.subtype==='initialize'?{}:${JSON.stringify(usage)}}}));
      });
    } else if (JSON.stringify(args) === '["app-server","--listen","stdio://"]') {
      fs.writeFileSync(${JSON.stringify(join(home, 'pid'))}, String(process.pid));
      ${body}
    } else { process.exit(99); }
  `,
    { mode: 0o700 }
  );
  return path;
}

function server(accountValue: unknown = account, ratesValue: unknown = rates, extra = ''): string {
  return `
    ${extra}
    const readline = require('node:readline');
    readline.createInterface({input:process.stdin}).on('line', (line) => {
      const request = JSON.parse(line); log(request);
      if (request.method === 'initialized') return;
      const result = request.method === 'initialize' ? {} : request.method === 'account/read' ? ${JSON.stringify(accountValue)} : ${JSON.stringify(ratesValue)};
      console.log(JSON.stringify({id:request.id,result}));
    });
    setInterval(() => {}, 1000);
  `;
}

function stopped(): void {
  const pid = Number(readFileSync(join(home, 'pid'), 'utf8'));
  expect(() => process.kill(pid, 0)).toThrow();
}

describe.skipIf(process.platform !== 'linux')('Штатная диагностика аккаунтов CLI', () => {
  it.each([false, true, null])('передаёт подтверждённую доступность использования Codex: %j', async (usageAllowed) => {
    cli('codex', server(account, { ...rates, ...(usageAllowed === null ? {} : { ordinaryUsageAllowed: usageAllowed }) }));
    const result = await codexAccount({ provider: 'codex' }, options());
    expect(result.usageAllowed).toBe(usageAllowed);
    if (usageAllowed === false) expect(result.message).toContain('ограничении использования');
  });

  it('адаптеры предоставляют отдельный метод чтения аккаунта', () => {
    expect(new ClaudeAdapter().account).toBeTypeOf('function');
    expect(new CodexAdapter().account).toBeTypeOf('function');
  });

  it('читает подтверждённые поля Claude, оставляя оплату и неизвестные показатели пустыми', async () => {
    cli(
      'claude',
      `console.log(${JSON.stringify(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', email: 'user@example.test', orgName: 'Студия', orgId: 'org-test', subscriptionType: 'pro', token: 'SECRET' }))});`
    );
    const result = await claudeAccount({ provider: 'claude' }, options());
    expect(result).toMatchObject({
      provider: 'claude',
      email: 'user@example.test',
      organization: 'Студия',
      authenticationMethod: 'claude.ai',
      plan: 'pro',
      subscriptionStatus: null,
      subscriptionExpiresAt: null,
      limits: null,
      credits: null,
      diagnostic: { availability: 'available', authorization: 'authenticated', version: '2.1.284' }
    });
    expect(Number.isFinite(Date.parse(result.checkedAt))).toBe(true);
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(calls().slice(0, 3)).toEqual([['--version'], ['auth', 'status', '--json'], ['auth', 'status', '--json']]);
  });

  it('не считает API key Claude подтверждением подписки', async () => {
    cli('claude', 'console.log(JSON.stringify({loggedIn:true,authMethod:"api_key",subscriptionType:null}));');
    expect(await claudeAccount({ provider: 'claude' }, options())).toMatchObject({
      authenticationMethod: 'api_key',
      plan: null,
      subscriptionStatus: null,
      email: null
    });
  });

  it.each([
    { authMethod: 'api_key', apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper' },
    { authMethod: 'claude.ai', apiProvider: 'firstParty', apiKeySource: 'apiKeyHelper' },
    { authMethod: 'claude.ai', apiProvider: 'firstParty', apiKeySource: 'ANTHROPIC_API_KEY' },
    { authMethod: 'claude.ai', apiProvider: 'firstParty', apiKeySource: null },
    { authMethod: 'claude.ai', apiProvider: 'thirdParty' },
    { authMethod: 'oauth_token', apiProvider: 'bedrock' },
    { authMethod: 'claude.ai' }
  ])('не запускает личный subscription control CLI для рабочего или неизвестного режима %j', async (metadata) => {
    cli('claude', `console.log(${JSON.stringify(JSON.stringify({ loggedIn: true, subscriptionType: null, ...metadata }))});`, undefined, undefined, {
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 22 } }
    });
    const result = await claudeAccount({ provider: 'claude' }, options());
    expect(result).toMatchObject({ plan: null, limits: null });
    expect(calls()).toHaveLength(3);
    expect(calls().every((call) => Array.isArray(call) && (call[0] === '--version' || call[0] === 'auth'))).toBe(true);
  });

  it.each([
    'console.log("invalid-json SECRET");',
    'console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty"}));process.exit(1);',
    'console.log(JSON.stringify({loggedIn:false,authMethod:"claude.ai",apiProvider:"firstParty"}));'
  ])('не запрашивает subscription usage при ошибочных или отрицательных метаданных Claude', async (metadataBody) => {
    cli(
      'claude',
      `
      if(fs.readFileSync(${JSON.stringify(join(home, 'calls'))},'utf8').trim().split('\\n').length===2) console.log(JSON.stringify({loggedIn:true}));
      else { ${metadataBody} }
    `,
      undefined,
      undefined,
      { subscription_type: 'pro', rate_limits_available: true, rate_limits: { five_hour: { utilization: 25 } } }
    );
    const result = await claudeAccount({ provider: 'claude' }, options());
    expect(result).toMatchObject({ email: null, plan: null, limits: null });
    expect(calls()).toHaveLength(3);
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('не подставляет тариф из изолированного usage CLI вместо отсутствующего тарифа auth status', async () => {
    cli('claude', 'console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty"}));', undefined, undefined, {
      subscription_type: 'pro',
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 0 } }
    });
    const result = await claudeAccount({ provider: 'claude' }, options());
    expect(result.plan).toBeNull();
    expect(result.limits?.[0].usedPercent).toBe(0);
    expect(calls()).toHaveLength(6);
  });

  it('получает динамические лимиты Claude без пользовательского хода, предпочитая их legacy-окнам', async () => {
    cli(
      'claude',
      'console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty",subscriptionType:"pro"}));',
      undefined,
      undefined,
      {
        subscription_type: 'pro',
        rate_limits_available: true,
        rate_limits: {
          five_hour: { utilization: 99 },
          limits: [
            { kind: 'session', group: 'session', percent: 0, resets_at: null, is_active: true },
            { kind: 'weekly_all', group: 'weekly', percent: 24, resets_at: '2030-01-01T00:00:00Z', is_active: true }
          ]
        }
      }
    );
    const result = await claudeAccount({ provider: 'claude' }, options());
    expect(result.plan).toBe('pro');
    expect(result.limits).toEqual([
      { label: 'session · session', usedPercent: 0, windowMinutes: null, resetsAt: null },
      { label: 'weekly · weekly_all', usedPercent: 24, windowMinutes: null, resetsAt: 1_893_456_000 }
    ]);
    expect(calls().slice(-2)).toEqual([
      { type: 'control_request', request_id: 'initialize', request: { subtype: 'initialize' } },
      { type: 'control_request', request_id: 'get_usage', request: { subtype: 'get_usage', skip_behaviors: true } }
    ]);
    expect(result.subscriptionExpiresAt).toBeNull();
    expect(result.subscriptionStatus).toBeNull();
  });

  it('использует legacy-окна Claude и различает недоступность показателей', async () => {
    cli('claude', 'console.log(JSON.stringify({loggedIn:true,authMethod:"oauth_token",apiProvider:"firstParty",apiKeySource:"none"}));', undefined, undefined, {
      rate_limits_available: true,
      rate_limits: { five_hour: { utilization: 0, resets_at: null }, seven_day: { utilization: 22, resets_at: '2030-01-01T00:00:00Z' } }
    });
    const result = await claudeAccount({ provider: 'claude' }, options());
    expect(result.limits).toEqual([
      { label: 'five_hour · 300 мин', usedPercent: 0, windowMinutes: 300, resetsAt: null },
      { label: 'seven_day · 10080 мин', usedPercent: 22, windowMinutes: 10080, resetsAt: 1_893_456_000 }
    ]);
    cli('claude', 'console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty"}));', undefined, undefined, {
      rate_limits_available: false,
      rate_limits: { five_hour: { utilization: 50 } }
    });
    expect((await claudeAccount({ provider: 'claude' }, options())).limits).toBeNull();
  });

  it('не вызывает экспериментальный метод Claude в старой версии', async () => {
    cli('claude', 'console.log(JSON.stringify({loggedIn:true,authMethod:"claude.ai",apiProvider:"firstParty"}));', undefined, '2.1.272 (Claude Code)');
    expect((await claudeAccount({ provider: 'claude' }, options())).limits).toBeNull();
    expect(calls()).toHaveLength(3);
  });

  it('не повторяет диагностику заведомо отсутствующего входа', async () => {
    cli('claude', 'console.log(JSON.stringify({loggedIn:false,email:"stale@example.test"}));process.exit(1);');
    const result = await claudeAccount({ provider: 'claude' }, options());
    expect(result.email).toBeNull();
    expect(result.diagnostic.authorization).toBe('unauthenticated');
    expect(calls()).toHaveLength(2);
  });

  it('запрашивает Codex только через initialize и два разрешённых чтения; закрывает сервер', async () => {
    cli('codex', server());
    const result = await codexAccount({ provider: 'codex' }, options());
    expect(result).toMatchObject({
      email: 'user@example.test',
      authenticationMethod: 'ChatGPT',
      plan: 'plus',
      organization: null,
      subscriptionStatus: null,
      subscriptionExpiresAt: null,
      credits: null
    });
    expect(result.limits).toEqual([{ label: 'codex · primary · 300 мин', usedPercent: 22, windowMinutes: 300, resetsAt: 1_900_000_000 }]);
    const invocations = calls();
    expect(invocations.slice(0, 3)).toEqual([['--version'], ['login', 'status'], ['app-server', '--listen', 'stdio://']]);
    expect(invocations.slice(3)).toEqual([
      { id: 1, method: 'initialize', params: { clientInfo: { name: 'songframe', title: 'SongFrame', version: '0.1.0' } } },
      { method: 'initialized' },
      { id: 2, method: 'account/read', params: { refreshToken: false } },
      { id: 3, method: 'account/rateLimits/read', params: {} }
    ]);
    expect(JSON.stringify(invocations)).not.toMatch(/thread\/|turn\/|account\/login|account\/logout|reset|refreshToken":true/);
    stopped();
  });

  it('предпочитает несколько корзин legacy, сохраняет нули и показывает подтверждённые кредиты', async () => {
    cli(
      'codex',
      server(account, {
        rateLimits: { primary: { usedPercent: 99 } },
        rateLimitsByLimitId: {
          codex: {
            primary: { usedPercent: 0, windowDurationMins: 0, resetsAt: 0 },
            secondary: { usedPercent: 80, windowDurationMins: 10080 },
            credits: { hasCredits: true, unlimited: false, balance: '0' }
          },
          review: { limitName: 'Code review', secondary: { usedPercent: 12, windowDurationMins: null, resetsAt: null } }
        }
      })
    );
    const result = await codexAccount({ provider: 'codex' }, options());
    expect(result.limits).toEqual([
      { label: 'codex · primary · 0 мин', usedPercent: 0, windowMinutes: 0, resetsAt: 0 },
      { label: 'codex · secondary · 10080 мин', usedPercent: 80, windowMinutes: 10080, resetsAt: null },
      { label: 'Code review · secondary', usedPercent: 12, windowMinutes: null, resetsAt: null }
    ]);
    expect(result.credits).toBe('0');
  });

  it.each(['apiKey', 'amazonBedrock'])('не угадывает подписку и email по режиму Codex %s', async (type) => {
    cli('codex', server({ account: { type, email: 'unexpected@example.test', planType: 'pro' } }, { rateLimits: {} }));
    const result = await codexAccount({ provider: 'codex' }, options());
    expect(result.authenticationMethod).toBe(type === 'apiKey' ? 'API key' : 'Amazon Bedrock');
    expect(result).toMatchObject({ email: null, plan: null, subscriptionStatus: null, limits: null, credits: null });
  });

  it('сохраняет неизвестные показатели пустыми и не подменяет пустую карту старой корзиной', async () => {
    cli('codex', server({ account: null }, { rateLimits: { primary: { usedPercent: 90 } }, rateLimitsByLimitId: {} }));
    expect(await codexAccount({ provider: 'codex' }, options())).toMatchObject({ email: null, plan: null, limits: null, credits: null });
  });

  it('считает явный серверный logout Codex достовернее локального login status', async () => {
    cli(
      'codex',
      server(
        { account: null, requiresOpenaiAuth: true },
        {
          rateLimits: { primary: { usedPercent: 50 }, credits: { hasCredits: true, unlimited: true } }
        }
      )
    );
    const result = await codexAccount({ provider: 'codex' }, options());
    expect(result).toMatchObject({
      email: null,
      plan: null,
      limits: null,
      credits: null,
      diagnostic: { availability: 'available', authorization: 'unauthenticated' }
    });
    expect(result.message).toContain('codex login');
    expect(result.diagnostic.message).toContain('вход не выполнен');
    stopped();
  });

  it('не принимает отсутствующее поле account в Codex за подтверждённый вход или logout', async () => {
    cli('codex', server({ requiresOpenaiAuth: true }, { rateLimits: {} }));
    const result = await codexAccount({ provider: 'codex' }, options());
    expect(result.diagnostic.authorization).toBe('unknown');
    expect(result.message).toContain('недоступна');
  });

  it('отбрасывает некорректные проценты вместо превращения их в нулевое использование', async () => {
    cli('codex', server(account, { rateLimits: { primary: { usedPercent: '0' }, secondary: { usedPercent: 101 }, credits: {} } }));
    expect(await codexAccount({ provider: 'codex' }, options())).toMatchObject({ limits: null, credits: null });
  });

  it('возвращает уже полученный аккаунт при ошибке чтения лимитов, без вывода stderr', async () => {
    cli(
      'codex',
      `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line);log(r);if(!r.id)return;
        if(r.method==='account/rateLimits/read') { console.error('SECRET private@example.test'); console.log(JSON.stringify({id:r.id,error:{message:'SECRET'}})); }
        else console.log(JSON.stringify({id:r.id,result:r.method==='initialize'?{}:${JSON.stringify(account)}}));
      });setInterval(()=>{},1000);
    `
    );
    const result = await codexAccount({ provider: 'codex' }, options());
    expect(result.email).toBe('user@example.test');
    expect(result.limits).toBeNull();
    expect(result.message).toContain('недоступна');
    expect(JSON.stringify(result)).not.toMatch(/SECRET|private@example/);
    stopped();
  });

  it('возвращает лимиты, даже когда account/read не поддерживается', async () => {
    cli(
      'codex',
      `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line);log(r);if(!r.id)return;
        console.log(JSON.stringify(r.method==='account/read'?{id:r.id,error:{code:-32601}}:{id:r.id,result:r.method==='initialize'?{}:${JSON.stringify(rates)}}));
      });setInterval(()=>{},1000);
    `
    );
    const result = await codexAccount({ provider: 'codex' }, options());
    expect(result.email).toBeNull();
    expect(result.diagnostic.authorization).toBe('unknown');
    expect(result.limits?.[0].usedPercent).toBe(22);
    expect(result.message).toContain('недоступна');
  });

  it.each(['malformed', 'overflow', 'earlyExit', 'timeout'])('завершает сервер при %s и не отдаёт его сырой вывод', async (mode) => {
    const body =
      mode === 'malformed'
        ? 'console.log("SECRET {invalid");setInterval(()=>{},1000);'
        : mode === 'overflow'
          ? 'process.stdout.write("SECRET".repeat(30000));setInterval(()=>{},1000);'
          : mode === 'earlyExit'
            ? 'process.exit(3);'
            : 'process.on("SIGTERM",()=>{});setInterval(()=>{},1000);';
    cli('codex', body);
    const start = Date.now();
    const result = await codexAccount({ provider: 'codex' }, { ...options(), timeoutMs: 250 });
    expect(result).toMatchObject({ email: null, plan: null, limits: null });
    expect(result.diagnostic.authorization).toBe('unknown');
    expect(result.message).toContain('недоступна');
    expect(JSON.stringify(result)).not.toContain('SECRET');
    expect(Date.now() - start).toBeLessThan(2500);
    stopped();
  });

  it('сохраняет частичный аккаунт при зависании следующего RPC', async () => {
    cli(
      'codex',
      `
      require('node:readline').createInterface({input:process.stdin}).on('line',line=>{
        const r=JSON.parse(line);log(r);if(!r.id||r.method==='account/rateLimits/read')return;
        console.log(JSON.stringify({id:r.id,result:r.method==='initialize'?{}:${JSON.stringify(account)}}));
      });setInterval(()=>{},1000);
    `
    );
    const result = await codexAccount({ provider: 'codex' }, { ...options(), timeoutMs: 250 });
    expect(result.email).toBe('user@example.test');
    expect(result.limits).toBeNull();
    stopped();
  });

  it('не запускает app-server на неподдерживаемой версии и сохраняет обычную диагностику', async () => {
    cli('codex', 'process.exit(99);', undefined, 'codex-cli 0.158.0');
    const result = await codexAccount({ provider: 'codex' }, options());
    expect(result.diagnostic).toMatchObject({ version: '0.158.0', authorization: 'authenticated' });
    expect(result.limits).toBeNull();
    expect(calls()).toEqual([['--version'], ['login', 'status']]);
  });

  it('без найденного CLI сохраняет диагностику и не пытается читать аккаунт', async () => {
    const result = await codexAccount({ provider: 'codex' }, options());
    expect(result.diagnostic.availability).toBe('not_found');
    expect(result.email).toBeNull();
  });
});
