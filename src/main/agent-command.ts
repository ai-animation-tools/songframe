/** Запуск внешних CLI агентов без shell в Linux и Windows: поиск файла, обёртки npm и завершение дерева процессов. */
import { spawnSync, type ChildProcess } from 'node:child_process';
import { constants } from 'node:fs';
import { access, readFile, stat } from 'node:fs/promises';
import { delimiter, dirname, extname, isAbsolute, join } from 'node:path';

export interface AgentCommand {
  file: string;
  args: string[];
}

/** Имена переменных окружения Windows не различают регистр, а у копии process.env ключ остаётся как есть (обычно Path). */
export function environmentKey(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = process.platform): string {
  if (platform !== 'win32') return name;
  return Object.keys(env).find((key) => key.toUpperCase() === name.toUpperCase()) ?? name;
}

export function environmentValue(env: NodeJS.ProcessEnv, name: string, platform: NodeJS.Platform = process.platform): string | undefined {
  return env[environmentKey(env, name, platform)];
}

/** Каталоги поиска из PATH: относительные записи пропускаются, чтобы не запускать файл из папки проекта. */
export function searchDirectories(env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): string[] {
  return (environmentValue(env, 'PATH', platform)?.split(delimiter) ?? []).filter(isAbsolute);
}

async function executable(path: string, platform: NodeJS.Platform): Promise<boolean> {
  try {
    if (!(await stat(path)).isFile()) return false;
    // В Windows признака исполнения нет: программу определяет расширение.
    if (platform !== 'win32') await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

/** В Windows нативная установка даёт .exe, глобальная установка npm — обёртку .cmd. */
export async function findExecutable(name: string, env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<string | undefined> {
  const names = platform === 'win32' ? [`${name}.exe`, `${name}.cmd`] : [name];
  for (const directory of searchDirectories(env, platform)) {
    for (const candidate of names.map((file) => join(directory, file))) if (await executable(candidate, platform)) return candidate;
  }
  return undefined;
}

/** Цель обёртки cmd-shim из npm: последний путь от %dp0% перед %*. @link https://github.com/npm/cmd-shim */
const SHIM_TARGET = /"%dp0%\\([^"\r\n]+)"\s+%\*/g;

/**
 * Node запускает .cmd только через cmd.exe, где аргументы разбираются по другим правилам. Поэтому обёртка npm
 * разворачивается в прямой вызов её цели: скрипт через node, программу .exe — как есть. Непонятная обёртка
 * запускается без изменений и даёт штатную ошибку запуска.
 */
export async function agentCommand(name: string, args: string[], env: NodeJS.ProcessEnv, platform: NodeJS.Platform = process.platform): Promise<AgentCommand> {
  // Поиск по имени в Windows сам дописывает только .exe и .com, поэтому имя без пути разрешаем здесь.
  const path = platform === 'win32' && !isAbsolute(name) ? ((await findExecutable(name, env, platform)) ?? name) : name;
  if (platform !== 'win32' || !['.cmd', '.bat'].includes(extname(path).toLowerCase())) return { file: path, args };
  let shim: string;
  try {
    shim = await readFile(path, 'utf8');
  } catch {
    return { file: path, args };
  }
  const target = [...shim.matchAll(SHIM_TARGET)].at(-1)?.[1];
  if (!target) return { file: path, args };
  const script = join(dirname(path), ...target.split('\\'));
  if (['.exe', '.com'].includes(extname(script).toLowerCase())) return { file: script, args };
  // Как и сама обёртка, предпочитаем node.exe рядом с ней, иначе ищем node в PATH.
  const local = join(dirname(path), 'node.exe');
  const node = (await executable(local, platform)) ? local : await findExecutable('node', env, platform);
  return { file: node ?? 'node.exe', args: [script, ...args] };
}

/** Завершает процесс вместе с потомками: в Linux группу detached-процесса, в Windows дерево через taskkill. */
export function killProcessTree(child: ChildProcess, env: NodeJS.ProcessEnv = process.env, platform: NodeJS.Platform = process.platform): void {
  if (!child.pid) return;
  if (platform === 'win32') {
    // taskkill /T находит потомков только через живой родитель; завершённый процесс не трогаем, его pid мог быть переиспользован.
    if (child.exitCode !== null || child.signalCode !== null) return;
    const root = environmentValue(env, 'SystemRoot', platform);
    const taskkill = root ? join(root, 'System32', 'taskkill.exe') : 'taskkill.exe';
    const result = spawnSync(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
    if (result.error || result.status !== 0) child.kill('SIGKILL');
    return;
  }
  try {
    process.kill(-child.pid, 'SIGKILL');
  } catch {
    child.kill('SIGKILL');
  }
}
