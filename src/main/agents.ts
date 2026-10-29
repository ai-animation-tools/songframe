/** Диагностика внешних CLI: только версия и статус входа, без рабочих запросов и хранения вывода. */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { AgentCheckResult } from '@shared/agents';
import { agentTitle } from '@shared/agent-providers';
import { AGENT_CLI_PROBES, type AgentCliProbe, type CliCommandResult } from './agent-probes';
import { normalizeAgentSettings } from './settings';

interface CheckOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  timeoutMs?: number;
}

/** Стандартные каталоги программ Linux, которых может не быть в PATH процесса, запущенного с рабочего стола. */
export const SYSTEM_DIRECTORIES = ['/usr/local/bin', '/usr/bin', '/bin'];

export function agentEnvironment(env: NodeJS.ProcessEnv = process.env, home = homedir(), system = SYSTEM_DIRECTORIES): NodeJS.ProcessEnv {
  const directories = [...new Set([...(env.PATH?.split(delimiter) ?? []), join(home, '.local', 'bin'), ...system])];
  return { ...env, PATH: directories.filter(isAbsolute).join(delimiter) };
}

type CommandResult = CliCommandResult;

function run(executable: string, args: string[], env: NodeJS.ProcessEnv, home: string, timeout: number): Promise<CommandResult> {
  return new Promise((resolve) => {
    // execFile ограничивает время и оба потока; shell не участвует даже для пути с пробелами.
    const child = execFile(executable, args, { env, cwd: home, timeout, maxBuffer: 32 * 1024, killSignal: 'SIGKILL' }, (error, stdout, stderr) => {
      const failure = error
        ? error.code === 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER'
          ? 'output_limit'
          : error.killed
            ? 'timeout'
            : typeof error.code === 'string'
              ? 'launch'
              : undefined
        : undefined;
      resolve({ code: error ? (error.code ?? null) : 0, stdout, output: `${stdout}\n${stderr}`, failure });
    });
    child.stdin?.end();
  });
}

function failureMessage(result: CommandResult): string | null {
  if (result.failure === 'timeout') return 'Агент не ответил вовремя. Проверьте его запуск в терминале и повторите проверку.';
  if (result.failure === 'output_limit') return 'Агент превысил допустимый объём ответа. Проверьте его запуск в терминале.';
  if (result.failure === 'launch') return 'Не удалось запустить агента. Проверьте права файла и наличие зависимостей, например Node.js для npm-установки.';
  return null;
}

function authorization(probe: AgentCliProbe, result: CommandResult): Pick<AgentCheckResult, 'authorization' | 'message'> {
  const failed = failureMessage(result);
  if (failed) return { authorization: 'unknown', message: failed };
  const recognized = probe.authorization(result);
  if (recognized) return recognized;
  if (
    result.code !== 0 &&
    /\b(ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ENETUNREACH)\b|\b(network is unreachable|failed to connect|connection refused)\b/i.test(result.output)
  ) {
    return { authorization: 'unknown', message: 'Агент сообщил об ошибке соединения. Проверьте сеть и повторите проверку.' };
  }
  return {
    authorization: 'unknown',
    message: 'Не удалось определить вход по ответу агента. Проверьте статус в терминале; может потребоваться обновление агента.'
  };
}

export async function checkAgent(input: unknown, options: CheckOptions = {}): Promise<AgentCheckResult> {
  const config = normalizeAgentSettings(input);
  if (!config) throw new Error('Сначала выберите агента.');
  const probe = AGENT_CLI_PROBES[config.provider];
  const home = options.home ?? homedir();
  // GUI часто не наследует PATH терминала; ~/.local/bin используется нативной установкой Claude.
  // Ручной путь к CLI не поддерживается: файл ищется только в PATH и стандартных каталогах.
  const env = agentEnvironment(options.env, home);
  let executablePath: string | undefined;
  for (const directory of env.PATH!.split(delimiter).filter(isAbsolute)) {
    const candidate = join(directory, probe.executable);
    try {
      if (!(await stat(candidate)).isFile()) continue;
      await access(candidate, constants.X_OK);
      executablePath = candidate;
      break;
    } catch {
      continue;
    }
  }
  if (!executablePath) {
    return {
      availability: 'not_found',
      authorization: 'unknown',
      message: `${agentTitle(config.provider)} не найден в PATH, ~/.local/bin, /usr/local/bin и /usr/bin. Установите его по официальной инструкции и повторите проверку.`
    };
  }
  const base = { executablePath, authorization: 'unknown' as const };
  const versionResult = await run(executablePath, ['--version'], env, home, options.timeoutMs ?? 10_000);
  const failed = failureMessage(versionResult);
  if (failed || versionResult.code !== 0) {
    return {
      ...base,
      availability: 'error',
      message: failed ?? `Команда версии завершилась с ошибкой. Проверьте ${agentTitle(config.provider)} и его зависимости в терминале.`
    };
  }
  const version = probe.version(versionResult.output);
  if (!version)
    return {
      ...base,
      availability: 'available',
      message: `${agentTitle(config.provider)} запускается, но его версия не распознана. Обновите его до поддерживаемой версии.`
    };
  const status = await run(executablePath, probe.statusArgs, env, home, options.timeoutMs ?? 10_000);
  return { ...base, availability: 'available', version, ...authorization(probe, status) };
}
