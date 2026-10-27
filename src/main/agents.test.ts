/** Подставные CLI проверяют аргументы, статусы и ограничения, не обращаясь к сервисам генерации. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { checkAgent } from './agents';
import { normalizeAgentSettings, SettingsStore } from './settings';

let work: string;
beforeEach(() => {
  work = mkdtempSync(join(tmpdir(), 'Агенты CLI '));
});
afterEach(() => {
  rmSync(work, { recursive: true, force: true });
});

function fake(path: string, body: string): string {
  mkdirSync(dirname(path), { recursive: true });
  // Абсолютный интерпретатор фикстуры не зависит от PATH, который проверяется отдельными сценариями.
  writeFileSync(path, `#!${process.execPath}\n${body}\n`, { mode: 0o700 });
  return path;
}

function cli(provider: 'claude' | 'codex', status: string, path = join(work, provider)): string {
  return fake(
    path,
    `
    const fs = require('node:fs');
    const args = process.argv.slice(2);
    fs.appendFileSync(${JSON.stringify(join(work, 'calls'))}, JSON.stringify(args) + '\\n');
    if (JSON.stringify(args) === '["--version"]') {
      console.log(${JSON.stringify(provider === 'codex' ? 'codex-cli 0.159.2' : '2.1.284 (Claude Code)')});
    } else if (JSON.stringify(args) === ${JSON.stringify(JSON.stringify(provider === 'codex' ? ['login', 'status'] : ['auth', 'status', '--json']))}) {
      ${status}
    } else { process.exit(99); }
  `
  );
}

describe('Глобальные настройки агента', () => {
  it('читает старый файл, нормализует выбор и сохраняет остальные поля при перезапуске и сбросе', () => {
    const file = join(work, 'settings.json');
    writeFileSync(file, JSON.stringify({ toolsRootOverride: '/ресурсы', futureField: 42 }));
    const store = new SettingsStore(work);
    expect(store.getAgent()).toBeNull();
    expect(store.saveAgent({ provider: 'codex', model: '  ', executablePath: '  /путь с пробелами/codex  ' })).toEqual({
      provider: 'codex',
      executablePath: '/путь с пробелами/codex'
    });
    const restarted = new SettingsStore(work);
    expect(restarted.getAgent()?.executablePath).toBe('/путь с пробелами/codex');
    restarted.write({ toolsRootOverride: null });
    expect(restarted.getAgent()?.provider).toBe('codex');
    restarted.saveAgent({ provider: 'claude', model: '  выбранная-модель  ' });
    expect(restarted.getAgent()).toEqual({ provider: 'claude', model: 'выбранная-модель' });
    restarted.saveAgent(null);
    // Отключение текстового агента сохраняет профили для следующего выбора и отдельного маршрута изображений.
    expect(restarted.getAgent()).toBeNull();
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual({
      toolsRootOverride: null,
      futureField: 42,
      agentProfiles: {
        codex: { provider: 'codex', executablePath: '/путь с пробелами/codex' },
        claude: { provider: 'claude', model: 'выбранная-модель' }
      }
    });
  });

  it('отклоняет неверные данные без перезаписи файла', () => {
    const store = new SettingsStore(work);
    store.write({ toolsRootOverride: null });
    const previous = readFileSync(join(work, 'settings.json'), 'utf8');
    for (const input of [
      { provider: 'kling' },
      { provider: 'codex', model: 3 },
      { provider: 'claude', executablePath: './claude' },
      { provider: 'codex', model: 'x\0y' },
      []
    ]) {
      expect(() => store.saveAgent(input)).toThrow();
    }
    expect(readFileSync(join(work, 'settings.json'), 'utf8')).toBe(previous);
    writeFileSync(join(work, 'settings.json'), '{"agent":{"provider":"kling"}}');
    expect(() => store.getAgent()).toThrow(/Неверный формат агента/);
    expect(() => normalizeAgentSettings({ provider: 'claude', executablePath: null })).toThrow();
  });
});

describe.skipIf(process.platform !== 'linux')('Диагностика Linux CLI', () => {
  it('находит Codex в PATH и выполняет только команды версии и входа, не сохраняя модель', async () => {
    cli('codex', 'console.error("Logged in using ChatGPT");');
    const result = await checkAgent({ provider: 'codex', model: 'выбранная-модель' }, { env: { PATH: work }, home: work });
    expect(result).toMatchObject({ executablePath: join(work, 'codex'), version: '0.159.2', availability: 'available', authorization: 'authenticated' });
    expect(readFileSync(join(work, 'calls'), 'utf8')).toBe('["--version"]\n["login","status"]\n');
    expect(new SettingsStore(work).getAgent()).toBeNull();
  });

  it('использует ручной путь с пробелами и кириллицей раньше PATH, не возвращает данные аккаунта', async () => {
    cli('claude', 'process.exit(99);');
    const executablePath = cli(
      'claude',
      'console.error("предупреждение"); console.log(JSON.stringify({ loggedIn: true, email: "private@example.test", token: "SECRET" }));',
      join(work, 'моя папка', 'Claude CLI')
    );
    const result = await checkAgent({ provider: 'claude', executablePath }, { env: { PATH: work }, home: work });
    expect(result).toMatchObject({ executablePath, version: '2.1.284', authorization: 'authenticated' });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|private@example/);
  });

  it('находит нативный CLI в домашнем .local/bin при минимальном PATH графического меню', async () => {
    const executablePath = cli('claude', 'console.log("{\\"loggedIn\\":true}");', join(work, '.local', 'bin', 'claude'));
    expect(await checkAgent({ provider: 'claude' }, { env: { PATH: '/usr/bin:/bin' }, home: work })).toMatchObject({
      executablePath,
      authorization: 'authenticated'
    });
  });

  it('объясняет отсутствие CLI и не подменяет исчезнувший ручной файл найденным в PATH', async () => {
    expect(await checkAgent({ provider: 'codex' }, { env: { PATH: work }, home: work })).toMatchObject({ availability: 'not_found', authorization: 'unknown' });
    cli('codex', 'console.log("Logged in using ChatGPT");');
    const result = await checkAgent({ provider: 'codex', executablePath: join(work, 'исчезнувший') }, { env: { PATH: work }, home: work });
    expect(result).toMatchObject({ availability: 'not_found', authorization: 'unknown' });
    expect(result.message).toContain('заново');
  });

  it('различает неисполняемый файл и ошибку команды версии', async () => {
    const executablePath = cli('claude', '');
    chmodSync(executablePath, 0o600);
    expect(await checkAgent({ provider: 'claude', executablePath })).toMatchObject({ availability: 'not_executable' });
    fake(executablePath, 'process.exit(2);');
    chmodSync(executablePath, 0o700);
    expect(await checkAgent({ provider: 'claude', executablePath })).toMatchObject({ availability: 'error', authorization: 'unknown' });
  });

  it('подтверждает отсутствие входа только по штатному статусу каждого провайдера', async () => {
    for (const provider of ['claude', 'codex'] as const) {
      const executablePath = cli(
        provider,
        provider === 'claude' ? 'console.log("{\\"loggedIn\\":false}"); process.exit(1);' : 'console.error("Not logged in"); process.exit(1);'
      );
      expect(await checkAgent({ provider, executablePath })).toMatchObject({ availability: 'available', authorization: 'unauthenticated' });
    }
  });

  it('не принимает неизвестный или противоречивый ответ за вход; выделяет явную сетевую ошибку', async () => {
    for (const [provider, body] of [
      ['codex', 'console.log("новый формат SECRET");'],
      ['claude', 'console.log("{\\"loggedIn\\":true}"); process.exit(1);']
    ] as const) {
      const executablePath = cli(provider, body);
      const result = await checkAgent({ provider, executablePath });
      expect(result.authorization).toBe('unknown');
      expect(JSON.stringify(result)).not.toContain('SECRET');
    }
    const executablePath = cli('codex', 'console.error("failed to connect SECRET"); process.exit(1);');
    expect((await checkAgent({ provider: 'codex', executablePath })).message).toContain('соединения');
  });

  it('не запускает статус для неизвестной версии CLI', async () => {
    const executablePath = fake(join(work, 'другой'), 'console.log("SECRET unknown version");');
    const result = await checkAgent({ provider: 'claude', executablePath });
    expect(result).toMatchObject({ availability: 'available', authorization: 'unknown' });
    expect(result.version).toBeUndefined();
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('завершает зависшую проверку входа и ограничивает объём ответа', async () => {
    const executablePath = cli('codex', 'setInterval(() => {}, 1000);');
    const start = Date.now();
    const result = await checkAgent({ provider: 'codex', executablePath }, { timeoutMs: 150 });
    expect(result).toMatchObject({ availability: 'available', version: '0.159.2', authorization: 'unknown' });
    expect(result.message).toContain('вовремя');
    expect(Date.now() - start).toBeLessThan(2500);
    cli('codex', 'process.stdout.write("SECRET".repeat(10000));');
    const overflow = await checkAgent({ provider: 'codex', executablePath });
    expect(overflow.authorization).toBe('unknown');
    expect(overflow.message).toContain('объём');
    expect(JSON.stringify(overflow)).not.toContain('SECRET');
  });
});
