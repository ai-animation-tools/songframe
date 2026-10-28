import { describe, expect, it } from 'vitest';
import { AGENT_PROVIDER_IDS, agentTitle, isAgentProvider } from '@shared/agent-providers';
import { createAgentAdapter } from './agent-adapters';
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
