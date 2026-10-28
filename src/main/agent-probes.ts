/** Как распознать версию и вход каждого CLI; общий порядок диагностики и разбор сбоев запуска — в agents.ts. */
import type { AgentCheckResult } from '@shared/agents';
import { AGENT_PROVIDERS, type AgentProvider } from '@shared/agent-providers';

export interface CliCommandResult {
  code: number | string | null;
  stdout: string;
  output: string;
  failure?: 'timeout' | 'output_limit' | 'launch';
}

export interface AgentCliProbe {
  executable: string;
  /** Выделяет версию из вывода `--version`; неизвестный формат не доказывает несовместимость. */
  version(output: string): string | undefined;
  statusArgs: string[];
  /** null — ответ не распознан, решение принимает общий разбор ошибок. */
  authorization(result: CliCommandResult): Pick<AgentCheckResult, 'authorization' | 'message'> | null;
}

const claude: AgentCliProbe = {
  executable: AGENT_PROVIDERS.claude.executable,
  version: (output) => /^(\d+\.\d+\.\d+(?:[-+][\w.-]+)?) \(Claude Code\)\s*$/m.exec(output)?.[1],
  statusArgs: ['auth', 'status', '--json'],
  authorization(result) {
    try {
      // CLI может вернуть адрес аккаунта и другие поля: наружу передаётся только признак входа.
      const data = JSON.parse(result.stdout.trim());
      if (data?.loggedIn === true && result.code === 0) return { authorization: 'authenticated', message: 'CLI сообщает, что вход выполнен.' };
      if (data?.loggedIn === false && result.code === 1)
        return { authorization: 'unauthenticated', message: `Выполните ${AGENT_PROVIDERS.claude.loginCommand} в терминале.` };
    } catch {
      // Старый или изменившийся формат не доказывает отсутствие входа.
    }
    return null;
  }
};

const codex: AgentCliProbe = {
  executable: AGENT_PROVIDERS.codex.executable,
  version: (output) => /^codex-cli (\d+\.\d+\.\d+(?:[-+][\w.-]+)?)\s*$/m.exec(output)?.[1],
  statusArgs: ['login', 'status'],
  authorization(result) {
    if (result.code === 0 && /^Logged in using [^\r\n]+$/m.test(result.output))
      return { authorization: 'authenticated', message: 'CLI сообщает, что учётные данные для входа найдены.' };
    if (result.code === 1 && /^Not logged in\s*$/m.test(result.output))
      return { authorization: 'unauthenticated', message: `Выполните ${AGENT_PROVIDERS.codex.loginCommand} в терминале.` };
    return null;
  }
};

/** Record требует описания для каждого провайдера реестра. */
export const AGENT_CLI_PROBES: Record<AgentProvider, AgentCliProbe> = { claude, codex };
