/** Диагностика внешних CLI: только версия и статус входа, без рабочих запросов и хранения вывода. */
import { agentsTexts } from '@shared/texts/agents';
import { execFile } from 'node:child_process';
import { homedir } from 'node:os';
import { delimiter, isAbsolute, join } from 'node:path';
import type { AgentCheckResult } from '@shared/agents';
import { agentTitle } from '@shared/agent-providers';
import { agentCommand, environmentKey, environmentValue, findExecutable, searchDirectories } from './agent-command';
import { AGENT_CLI_PROBES, type AgentCliProbe, type CliCommandResult } from './agent-probes';
import { normalizeAgentSettings } from './settings';

interface CheckOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  timeoutMs?: number;
  platform?: NodeJS.Platform;
}

/** Стандартные каталоги программ Linux, которых может не быть в PATH процесса, запущенного с рабочего стола. */
export const SYSTEM_DIRECTORIES = ['/usr/local/bin', '/usr/bin', '/bin'];

/** Каталоги установок агентов в Windows: ~/.local/bin у нативного Claude, %APPDATA%\npm у глобального npm, Node.js для его обёрток. */
export function windowsDirectories(env: NodeJS.ProcessEnv): string[] {
  const appData = environmentValue(env, 'APPDATA', 'win32');
  const programFiles = environmentValue(env, 'ProgramFiles', 'win32');
  return [...(appData ? [join(appData, 'npm')] : []), ...(programFiles ? [join(programFiles, 'nodejs')] : [])];
}

export function agentEnvironment(
  env: NodeJS.ProcessEnv = process.env,
  home = homedir(),
  system?: string[],
  platform: NodeJS.Platform = process.platform
): NodeJS.ProcessEnv {
  const extra = system ?? (platform === 'win32' ? windowsDirectories(env) : SYSTEM_DIRECTORIES);
  const directories = [...new Set([...searchDirectories(env, platform), join(home, '.local', 'bin'), ...extra])];
  // Одно имя переменной: в Windows вторая запись PATH рядом с Path сделала бы поиск дочернего процесса неоднозначным.
  const key = environmentKey(env, 'PATH', platform);
  return { ...env, [key]: directories.filter(isAbsolute).join(delimiter) };
}

type CommandResult = CliCommandResult;

async function run(
  executable: string,
  args: string[],
  env: NodeJS.ProcessEnv,
  home: string,
  timeout: number,
  platform: NodeJS.Platform
): Promise<CommandResult> {
  const command = await agentCommand(executable, args, env, platform);
  return new Promise((resolve) => {
    // execFile ограничивает время и оба потока; shell не участвует даже для пути с пробелами.
    const options = { env, cwd: home, timeout, maxBuffer: 32 * 1024, killSignal: 'SIGKILL' as const, windowsHide: true };
    const child = execFile(command.file, command.args, options, (error, stdout, stderr) => {
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
  if (result.failure === 'timeout') return agentsTexts.checkTimeout;
  if (result.failure === 'output_limit') return agentsTexts.checkOutputLimit;
  if (result.failure === 'launch') return agentsTexts.checkLaunchFailed;
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
    return { authorization: 'unknown', message: agentsTexts.checkConnectionFailed };
  }
  return {
    authorization: 'unknown',
    message: agentsTexts.authorizationUnknown
  };
}

export async function checkAgent(input: unknown, options: CheckOptions = {}): Promise<AgentCheckResult> {
  const config = normalizeAgentSettings(input);
  if (!config) throw new Error(agentsTexts.chooseAgent);
  const probe = AGENT_CLI_PROBES[config.provider];
  const home = options.home ?? homedir();
  const platform = options.platform ?? process.platform;
  // GUI часто не наследует PATH терминала; ~/.local/bin используется нативной установкой Claude.
  // Ручной путь к CLI не поддерживается: файл ищется только в PATH и стандартных каталогах.
  const env = agentEnvironment(options.env, home, undefined, platform);
  const executablePath = await findExecutable(probe.executable, env, platform);
  if (!executablePath) {
    return {
      availability: 'not_found',
      authorization: 'unknown',
      message: agentsTexts.notFound({ provider: agentTitle(config.provider), windows: platform === 'win32' })
    };
  }
  const base = { executablePath, authorization: 'unknown' as const };
  const versionResult = await run(executablePath, ['--version'], env, home, options.timeoutMs ?? 10_000, platform);
  const failed = failureMessage(versionResult);
  if (failed || versionResult.code !== 0) {
    return {
      ...base,
      availability: 'error',
      message: failed ?? agentsTexts.versionCheckFailed({ provider: agentTitle(config.provider) })
    };
  }
  const version = probe.version(versionResult.output);
  if (!version)
    return {
      ...base,
      availability: 'available',
      message: agentsTexts.checkVersionUnknown({ provider: agentTitle(config.provider) })
    };
  const status = await run(executablePath, probe.statusArgs, env, home, options.timeoutMs ?? 10_000, platform);
  return { ...base, availability: 'available', version, ...authorization(probe, status) };
}
