/** Официальный Kling CLI запускается Node из Electron; вход и хранение учётных данных остаются у самого CLI. */
import { spawn } from 'node:child_process';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type { ToolResult } from '@shared/types';
import type { PythonOptions } from './python-runtime';

export interface KlingRuntimeOptions extends PythonOptions {
  execPath?: string;
}

interface KlingRuntime {
  bundled: boolean;
  command: string;
  argsPrefix: string[];
  env: NodeJS.ProcessEnv;
  version?: string;
}

/** Packaged-путь сохраняется и при повреждении поставки, чтобы отсутствие CLI не маскировалось внешней установкой. */
export function klingPaths(options: KlingRuntimeOptions): { executable: string; script: string; packageFile: string } | null {
  const root = options.packaged ? join(options.resourcesPath ?? '', 'kling') : join(options.toolsRoot ?? process.cwd(), 'build/runtime/kling');
  if (!options.packaged && !existsSync(root)) return null;
  return { executable: options.execPath ?? process.execPath, script: join(root, 'dist/cli.js'), packageFile: join(root, 'package.json') };
}

export function resolveKling(options: KlingRuntimeOptions): KlingRuntime {
  const env: NodeJS.ProcessEnv = { ...(options.env ?? process.env), KLING_NONINTERACTIVE: '1' };
  if (env.SONGFRAME_KLING_CLI) return { bundled: false, command: env.SONGFRAME_KLING_CLI, argsPrefix: [], env };
  const paths = klingPaths(options);
  if (!paths) return { bundled: false, command: 'kling', argsPrefix: [], env };
  try {
    const pkg = JSON.parse(readFileSync(paths.packageFile, 'utf8'));
    if (pkg.name !== '@klingai/cli-global' || typeof pkg.version !== 'string' || !pkg.version) throw new Error('Не найден manifest пакета Kling.');
    const script = statSync(paths.script);
    if (!script.isFile() || script.size === 0) throw new Error('Нет исполняемого JS-файла Kling.');
    return { bundled: true, command: paths.executable, argsPrefix: [paths.script], env: { ...env, ELECTRON_RUN_AS_NODE: '1' }, version: pkg.version };
  } catch (error) {
    throw new Error(`Встроенный Kling недоступен (${paths.packageFile}): ${(error as Error).message}. Восстановите поставку.`, { cause: error });
  }
}

/** stdin закрыт: пользователь отвечает приложению, а не скрытому консольному prompt официального CLI. */
export async function runKling(
  options: KlingRuntimeOptions,
  args: string[],
  settings: { timeoutMs?: number; onOutput?: (text: string, error?: boolean) => void } = {}
): Promise<ToolResult> {
  const runtime = resolveKling(options);
  const argv = [...runtime.argsPrefix, ...args];
  const command = [runtime.command, ...argv].map((part) => JSON.stringify(part)).join(' ');
  // Официальная браузерная авторизация ждёт до пяти минут; наружный лимит оставляет время на её завершение.
  const timeoutMs = settings.timeoutMs ?? 310000;
  const windows = (options.platform ?? process.platform) === 'win32';
  return new Promise((resolve) => {
    let stdout = '';
    let stderr = '';
    let finished = false;
    let timedOut = false;
    const output = (text: string, error = false): void => {
      if (finished) return;
      if (error) stderr += text;
      else stdout += text;
      settings.onOutput?.(text, error);
    };
    const child = spawn(runtime.command, argv, {
      env: runtime.env,
      // app.getAppPath() может указывать на виртуальный app.asar; ОС принимает только настоящую папку ресурсов.
      cwd: (options.packaged ? options.resourcesPath : options.toolsRoot) ?? process.cwd(),
      // Неизменённый bundle передаётся Electron отдельным аргументом; shell нужен лишь внешнему Windows npm shim.
      shell: !runtime.bundled && windows && !/\.(exe|com)$/i.test(runtime.command),
      windowsHide: true,
      stdio: ['ignore', 'pipe', 'pipe']
    });
    const finish = (code: number | null): void => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve({ code, stdout, stderr, command });
    };
    const timer = setTimeout(() => {
      timedOut = true;
      output(`\nПревышено время выполнения Kling (${timeoutMs} мс).\n`, true);
      finish(null);
      child.kill('SIGKILL');
      child.stdout.destroy();
      child.stderr.destroy();
    }, timeoutMs);
    child.stdout.setEncoding('utf8').on('data', (text: string) => {
      output(text);
      if (finished || args[0] !== 'login') return;
      try {
        const result = JSON.parse(stdout);
        if (result?.ok !== true || result.loggedIn !== true) return;
      } catch {
        return;
      }
      // CLI выдаёт этот JSON только после сохранения входа; браузерный helper может удерживать процесс и его трубы.
      finish(0);
      child.kill();
      child.stdout.destroy();
      child.stderr.destroy();
    });
    child.stderr.setEncoding('utf8').on('data', (text: string) => output(text, true));
    child.on('error', (error) => {
      output(`\nОшибка запуска Kling: ${error.message}\n`, true);
      finish(null);
    });
    child.on('close', (code) => finish(timedOut ? null : code));
  });
}
