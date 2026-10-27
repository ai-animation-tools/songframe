/** Окружение внешних CLI при запуске из рабочего стола; bundled Python и изолированные smoke его не требуют. */
import { execFile } from 'node:child_process';
import { constants } from 'node:fs';
import { access, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join } from 'node:path';
import { agentEnvironment } from './agents';

interface ExternalEnvironmentOptions {
  env?: NodeJS.ProcessEnv;
  home?: string;
  platform?: NodeJS.Platform;
  timeoutMs?: number;
}

async function executable(path: string): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function prepend(env: NodeJS.ProcessEnv, directory: string): NodeJS.ProcessEnv {
  return { ...env, PATH: [...new Set([directory, ...(env.PATH?.split(':') ?? [])])].join(':') };
}

async function found(command: string, env: NodeJS.ProcessEnv): Promise<boolean> {
  for (const directory of env.PATH?.split(':') ?? []) if (await executable(join(directory, command))) return true;
  return false;
}

/** nvm сам выбирает default: приложение не перебирает версии и не читает интерактивные профили. @link https://github.com/nvm-sh/nvm#usage */
function defaultNode(script: string, env: NodeJS.ProcessEnv, home: string, timeoutMs: number): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      '/bin/bash',
      ['-c', '. "$1" --no-use >/dev/null && nvm which default', 'songframe-nvm', script],
      { env: { ...env, BASH_ENV: undefined, ENV: undefined }, cwd: home, timeout: timeoutMs, maxBuffer: 32 * 1024, killSignal: 'SIGKILL' },
      (error, stdout) => resolve(error ? null : stdout.trim())
    );
  });
}

export async function externalEnvironment(options: ExternalEnvironmentOptions = {}): Promise<NodeJS.ProcessEnv> {
  const input = options.env ?? process.env;
  if ((options.platform ?? process.platform) !== 'linux') return { ...input };
  const home = options.home ?? homedir();
  let env = agentEnvironment(input, home);
  // Сохраняем исходный каталог выбранного CLI: realpath symlink npm ведёт в dist, где sibling Node отсутствует.
  const manualDirectory = input.SONGFRAME_KLING_CLI && isAbsolute(input.SONGFRAME_KLING_CLI) ? dirname(input.SONGFRAME_KLING_CLI) : null;
  if (manualDirectory) env = prepend(env, manualDirectory);
  const kling = input.SONGFRAME_KLING_CLI ?? 'kling';
  if ((await found('node', env)) && (isAbsolute(kling) ? await executable(kling) : await found(kling, env))) return env;

  let bin = input.NVM_BIN;
  if (!bin || !isAbsolute(bin) || !(await executable(join(bin, 'node')))) {
    const nvmDirectory = input.NVM_DIR || (input.XDG_CONFIG_HOME ? join(input.XDG_CONFIG_HOME, 'nvm') : join(home, '.nvm'));
    const script = join(nvmDirectory, 'nvm.sh');
    try {
      if (!(await stat(script)).isFile()) return env;
    } catch {
      return env;
    }
    const node = await defaultNode(script, { ...env, NVM_DIR: nvmDirectory }, home, options.timeoutMs ?? 3000);
    if (!node || !isAbsolute(node) || !(await executable(node))) return env;
    bin = dirname(node);
  }
  env = prepend(env, bin);
  return manualDirectory ? prepend(env, manualDirectory) : env;
}
