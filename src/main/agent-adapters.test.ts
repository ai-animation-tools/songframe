import { describe, expect, it } from 'vitest';
import { AGENT_PROVIDER_IDS, AGENT_PROVIDERS, agentTitle, isAgentProvider } from '@shared/agent-providers';
import { ClaudeAdapter, createAgentAdapter } from './agent-adapters';
import { AGENT_CLI_PROBES } from './agent-probes';

describe('реестр агентов', () => {
  it('для каждого провайдера есть адаптер и описание проверки', () => {
    for (const provider of AGENT_PROVIDER_IDS) {
      expect(createAgentAdapter(provider).provider).toBe(provider);
      expect(AGENT_CLI_PROBES[provider].executable).toBeTruthy();
    }
  });

  it('распознаёт только провайдеров реестра', () => {
    expect(isAgentProvider('claude')).toBe(true);
    expect(isAgentProvider('codex')).toBe(true);
    expect(isAgentProvider('test')).toBe(false);
    expect(isAgentProvider('toString')).toBe(false);
    expect(isAgentProvider(undefined)).toBe(false);
  });

  it('без выбора перечисляет всех агентов', () => {
    expect(agentTitle('claude')).toBe('Claude Code');
    expect(agentTitle(null)).toBe('Claude Code или Codex');
  });
});

describe('режимы запуска', () => {
  it('Codex отклоняет вложения в режиме write до запуска процесса', () => {
    const adapter = createAgentAdapter('codex');
    expect(() => adapter.args({ provider: 'codex' }, '0.159.0', 'write', [{ path: '/кадр.png', data: Buffer.from('png'), mediaType: 'image/png' }])).toThrow(
      /без записи файлов/
    );
  });

  it('Codex пишет кандидатов только в режиме write', () => {
    const adapter = createAgentAdapter('codex');
    const sandbox = (mode: 'read' | 'write'): string | undefined => {
      const args = adapter.args({ provider: 'codex' }, '0.159.0', mode);
      return args[args.indexOf('--sandbox') + 1];
    };
    expect(sandbox('read')).toBe('read-only');
    expect(sandbox('write')).toBe('workspace-write');
  });

  it('Claude отклоняет режим write до запуска', () => {
    const adapter = createAgentAdapter('claude');
    expect(adapter.args({ provider: 'claude' }, '2.1.0', 'read')).toContain('--permission-mode');
    expect(() => adapter.args({ provider: 'claude' }, '2.1.0', 'write')).toThrow('штатный режим создания кандидатов');
  });

  it('распознаёт версию по выводу каждого CLI', () => {
    expect(AGENT_CLI_PROBES.claude.version('2.1.5 (Claude Code)\n')).toBe('2.1.5');
    expect(AGENT_CLI_PROBES.codex.version('codex-cli 0.160.1\n')).toBe('0.160.1');
    expect(AGENT_CLI_PROBES.codex.version('2.1.5 (Claude Code)')).toBeUndefined();
  });
});

/** Это бюджеты SongFrame: API/CLI могут иметь другие ограничения, поэтому проверяется итоговый stdin. */
describe('бюджет изображений и сериализованного ввода', () => {
  it('публикует отдельный бюджет копий проверки для каждого агента', () => {
    expect(AGENT_PROVIDERS.claude.reviewImageBudgetBytes).toBe(6 * 1024 * 1024);
    expect(AGENT_PROVIDERS.codex.reviewImageBudgetBytes).toBe(16 * 1024 * 1024);
  });

  it('Claude отклоняет два допустимых raw-файла по 4 МиБ, когда base64 и JSON превышают предел SongFrame', () => {
    const adapter = new ClaudeAdapter();
    const images = ['первая.png', 'вторая.jpg'].map((path) => ({ path: `/${path}`, data: Buffer.alloc(4 * 1024 * 1024), mediaType: 'image/png' as const }));
    expect(() => adapter.input('Проверь кадры', images)).toThrow(/INVALID_INPUT.*10 000 000 байт/);
  });

  it('6 МиБ вложений оставляют место максимальным обычным промпту, контексту и инструкциям проекта', () => {
    const adapter = new ClaudeAdapter();
    const normalText = 'Я'.repeat(128 * 1024);
    expect(Buffer.byteLength(normalText)).toBe(256 * 1024);
    const prompt = `Постоянные инструкции:\n${normalText}\nЗадача:\n${normalText}\nКонтекст:\n${normalText}`;
    const images = ['первая.png', 'вторая.jpg'].map((path) => ({ path: `/${path}`, data: Buffer.alloc(3 * 1024 * 1024), mediaType: 'image/png' as const }));
    const input = adapter.input(prompt, images);
    expect(Buffer.byteLength(input, 'utf8')).toBeLessThan(10_000_000);
    const message = JSON.parse(input).message;
    expect(message.content).toHaveLength(3);
    expect(message.content[0]).toEqual({ type: 'text', text: prompt });
    expect(message.content.slice(1).map((block: { source: { data: string } }) => Buffer.from(block.source.data, 'base64').length)).toEqual([
      3 * 1024 * 1024,
      3 * 1024 * 1024
    ]);
  });

  it('считает полный UTF-8 размер, а обычный текст без вложений сохраняет дословно', () => {
    const adapter = new ClaudeAdapter();
    const plain = 'Текст\r\nс переносом';
    expect(adapter.input(plain, [])).toBe(plain);
    const oversized = 'Я'.repeat(5_000_001);
    expect(oversized.length).toBeLessThan(10_000_000);
    expect(() => adapter.input(oversized, [])).toThrow(/INVALID_INPUT/);
  });
});
