/** Подставные CLI проверяют аргументы, статусы и ограничения, не обращаясь к сервисам генерации. */
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, dirname, join } from 'node:path';
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

// Пустой home и PATH из одного временного каталога не дают найти настоящие claude/codex из ~/.local/bin.
const isolated = () => ({ env: { PATH: work }, home: work });

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
    // Прежнее поле пути CLI молча отбрасывается: файл ищется только автоматически.
    expect(store.saveAgent({ provider: 'codex', model: '  ', executablePath: '  /путь с пробелами/codex  ' })).toEqual({ provider: 'codex' });
    const restarted = new SettingsStore(work);
    expect(restarted.getAgent()).toEqual({ provider: 'codex' });
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
        codex: { provider: 'codex' },
        claude: { provider: 'claude', model: 'выбранная-модель' }
      }
    });
  });

  it('отклоняет неверные данные без перезаписи файла', () => {
    const store = new SettingsStore(work);
    store.write({ toolsRootOverride: null });
    const previous = readFileSync(join(work, 'settings.json'), 'utf8');
    for (const input of [{ provider: 'test' }, { provider: 'codex', model: 3 }, { provider: 'codex', model: 'x\0y' }, []]) {
      expect(() => store.saveAgent(input)).toThrow();
    }
    expect(readFileSync(join(work, 'settings.json'), 'utf8')).toBe(previous);
    writeFileSync(join(work, 'settings.json'), '{"agent":{"provider":"test"}}');
    expect(() => store.getAgent()).toThrow(/Неверный формат агента/);
    expect(() => normalizeAgentSettings({ provider: 'claude', model: null })).toThrow();
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

  it('находит CLI в каталоге с пробелами и кириллицей, берёт первый в PATH, не возвращает данные аккаунта', async () => {
    const first = join(work, 'моя папка');
    const executablePath = cli(
      'claude',
      'console.error("предупреждение"); console.log(JSON.stringify({ loggedIn: true, email: "private@example.test", token: "SECRET" }));',
      join(first, 'claude')
    );
    cli('claude', 'process.exit(99);');
    const result = await checkAgent({ provider: 'claude' }, { env: { PATH: `${first}${delimiter}${work}` }, home: work });
    expect(result).toMatchObject({ executablePath, version: '2.1.284', authorization: 'authenticated' });
    expect(JSON.stringify(result)).not.toMatch(/SECRET|private@example/);
  });

  it('ищет только файл с именем CLI своего провайдера', async () => {
    cli('codex', 'console.log("Logged in using ChatGPT");');
    fake(join(work, 'Claude CLI'), 'console.log("2.1.284 (Claude Code)");');
    expect(await checkAgent({ provider: 'claude' }, isolated())).toMatchObject({ availability: 'not_found', authorization: 'unknown' });
    expect(await checkAgent({ provider: 'codex' }, isolated())).toMatchObject({ executablePath: join(work, 'codex'), availability: 'available' });
  });

  it('находит нативный CLI в домашнем .local/bin при минимальном PATH графического меню', async () => {
    const executablePath = cli('claude', 'console.log("{\\"loggedIn\\":true}");', join(work, '.local', 'bin', 'claude'));
    expect(await checkAgent({ provider: 'claude' }, { env: { PATH: '/usr/bin:/bin' }, home: work })).toMatchObject({
      executablePath,
      authorization: 'authenticated'
    });
  });

  it('объясняет отсутствие CLI и игнорирует прежнее поле пути в настройках', async () => {
    const missing = await checkAgent({ provider: 'codex' }, isolated());
    expect(missing).toMatchObject({ availability: 'not_found', authorization: 'unknown' });
    expect(missing.message).toBe(
      'Codex не найден в PATH, ~/.local/bin, /usr/local/bin и /usr/bin. Установите его по официальной инструкции и повторите проверку.'
    );
    const elsewhere = cli('codex', 'console.log("Logged in using ChatGPT");', join(work, 'вне PATH', 'codex'));
    expect(await checkAgent({ provider: 'codex', executablePath: elsewhere }, isolated())).toMatchObject({ availability: 'not_found' });
    expect(() => readFileSync(join(work, 'calls'))).toThrow();
  });

  it('пропускает неисполняемый файл и каталог с именем CLI, отличает ошибку команды версии', async () => {
    const blocked = join(work, 'без прав');
    const executablePath = cli('claude', '', join(blocked, 'claude'));
    chmodSync(executablePath, 0o600);
    mkdirSync(join(work, 'каталог', 'claude'), { recursive: true });
    const env = { PATH: [blocked, join(work, 'каталог')].join(delimiter) };
    expect(await checkAgent({ provider: 'claude' }, { env, home: work })).toMatchObject({ availability: 'not_found' });
    const next = cli('claude', 'console.log("{\\"loggedIn\\":true}");');
    expect(await checkAgent({ provider: 'claude' }, { env: { PATH: [blocked, work].join(delimiter) }, home: work })).toMatchObject({
      executablePath: next,
      availability: 'available'
    });
    fake(executablePath, 'process.exit(2);');
    chmodSync(executablePath, 0o700);
    expect(await checkAgent({ provider: 'claude' }, { env, home: work })).toMatchObject({ executablePath, availability: 'error', authorization: 'unknown' });
  });

  it('подтверждает отсутствие входа только по штатному статусу каждого провайдера', async () => {
    for (const provider of ['claude', 'codex'] as const) {
      cli(provider, provider === 'claude' ? 'console.log("{\\"loggedIn\\":false}"); process.exit(1);' : 'console.error("Not logged in"); process.exit(1);');
      expect(await checkAgent({ provider }, isolated())).toMatchObject({ availability: 'available', authorization: 'unauthenticated' });
    }
  });

  it('не принимает неизвестный или противоречивый ответ за вход; выделяет явную сетевую ошибку', async () => {
    for (const [provider, body] of [
      ['codex', 'console.log("новый формат SECRET");'],
      ['claude', 'console.log("{\\"loggedIn\\":true}"); process.exit(1);']
    ] as const) {
      cli(provider, body);
      const result = await checkAgent({ provider }, isolated());
      expect(result.authorization).toBe('unknown');
      expect(JSON.stringify(result)).not.toContain('SECRET');
    }
    cli('codex', 'console.error("failed to connect SECRET"); process.exit(1);');
    expect((await checkAgent({ provider: 'codex' }, isolated())).message).toBe('Агент сообщил об ошибке соединения. Проверьте сеть и повторите проверку.');
  });

  it('не запускает статус для неизвестной версии CLI', async () => {
    fake(join(work, 'claude'), 'console.log("SECRET unknown version");');
    const result = await checkAgent({ provider: 'claude' }, isolated());
    expect(result).toMatchObject({ availability: 'available', authorization: 'unknown' });
    expect(result.version).toBeUndefined();
    expect(result.message).toBe('Claude Code запускается, но его версия не распознана. Обновите его до поддерживаемой версии.');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });

  it('завершает зависшую проверку входа и ограничивает объём ответа', async () => {
    cli('codex', 'setInterval(() => {}, 1000);');
    const start = Date.now();
    const result = await checkAgent({ provider: 'codex' }, { ...isolated(), timeoutMs: 150 });
    expect(result).toMatchObject({ availability: 'available', version: '0.159.2', authorization: 'unknown' });
    expect(result.message).toBe('Агент не ответил вовремя. Проверьте его запуск в терминале и повторите проверку.');
    expect(Date.now() - start).toBeLessThan(2500);
    cli('codex', 'process.stdout.write("SECRET".repeat(10000));');
    const overflow = await checkAgent({ provider: 'codex' }, isolated());
    expect(overflow.authorization).toBe('unknown');
    expect(overflow.message).toBe('Агент превысил допустимый объём ответа. Проверьте его запуск в терминале.');
    expect(JSON.stringify(overflow)).not.toContain('SECRET');
  });
});
