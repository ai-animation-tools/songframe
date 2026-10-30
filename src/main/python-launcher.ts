/** Общий запуск инструментов для коротких вызовов и Jobs, с одной обработкой ошибок и таймаутов. */

import { environmentTexts } from '@shared/texts/environment';
import { spawn, spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { requireMediaBinaries } from './media-runtime';
import type { ToolResult } from '@shared/types';
import { resolvePython, type PythonOptions, type PythonRuntime } from './python-runtime';

export const TOOL_TIMEOUT = 10 * 60 * 1000;

export interface LaunchOptions {
  timeoutMs?: number;
  onOutput?: (text: string, error?: boolean) => void;
  signal?: AbortSignal;
}

export class PythonLauncher {
  constructor(readonly options: PythonOptions) {}

  runtime(): PythonRuntime {
    return resolvePython(this.options);
  }

  /** Статус интерфейса использует тот же выбор, что и запуск; повторная проверка видит исправленный runtime. */
  available(): boolean {
    try {
      this.runtime();
      return true;
    } catch {
      return false;
    }
  }

  async run(project: string | null, name: string, args: string[], options: LaunchOptions = {}): Promise<ToolResult> {
    if (!this.options.toolsRoot) throw new Error(environmentTexts.main.toolsRootMissing);
    if (!/^[a-z_]+$/.test(name)) throw new Error(environmentTexts.main.toolNameInvalid(name));
    requireMediaBinaries(this.options);
    const script = resolve(this.options.toolsRoot, 'tools', name, `${name}.py`);
    return this.execute([script, ...(project ? ['--project', resolve(project)] : []), ...args], options, project ?? undefined);
  }

  /** Диагностика использует те же потоки и таймауты, не блокируя главный процесс spawnSync. */
  async execute(args: string[], options: LaunchOptions = {}, project?: string): Promise<ToolResult> {
    if (options.signal?.aborted) return { code: null, stdout: '', stderr: environmentTexts.main.executionStopped, command: '' };
    const runtime = this.runtime();
    const argv = [...runtime.argsPrefix, ...args];
    const command = [runtime.command, ...argv].map((part) => JSON.stringify(part)).join(' ');
    const timeout = options.timeoutMs ?? TOOL_TIMEOUT;
    return new Promise((resolveResult) => {
      let stdout = '';
      let stderr = '';
      let finished = false;
      let timedOut = false;
      let aborted = false;
      const output = (text: string, error = false): void => {
        if (error) stderr += text;
        else stdout += text;
        options.onOutput?.(text, error);
      };
      const child = spawn(runtime.command, argv, {
        cwd: runtime.cwd,
        env: { ...runtime.env, ...(project ? { SONGFRAME_PROJECT: resolve(project) } : {}) },
        shell: false,
        windowsHide: true,
        detached: process.platform !== 'win32',
        stdio: ['ignore', 'pipe', 'pipe']
      });
      const finish = (code: number | null): void => {
        if (finished) return;
        finished = true;
        clearTimeout(timer);
        options.signal?.removeEventListener('abort', abort);
        resolveResult({ code, stdout, stderr, command });
      };
      // Таймаут и отмена завершают всё дерево, включая вложенный CLI или распознавание.
      const stop = (): void => {
        if (child.pid) {
          if (process.platform === 'win32') {
            const systemRoot = runtime.env.SystemRoot ?? runtime.env.SYSTEMROOT;
            const taskkill = systemRoot ? join(systemRoot, 'System32', 'taskkill.exe') : 'taskkill';
            const result = spawnSync(taskkill, ['/pid', String(child.pid), '/T', '/F'], { windowsHide: true, timeout: 5000 });
            if (result.error || result.status !== 0) child.kill('SIGKILL');
          } else {
            try {
              process.kill(-child.pid, 'SIGKILL');
            } catch {
              child.kill('SIGKILL');
            }
          }
        }
      };
      const abort = (): void => {
        if (finished || aborted) return;
        aborted = true;
        output(environmentTexts.main.executionStoppedOutput, true);
        stop();
      };
      const timer = setTimeout(() => {
        timedOut = true;
        output(environmentTexts.main.executionTimedOutOutput(timeout), true);
        stop();
      }, timeout);
      child.stdout.setEncoding('utf8').on('data', (chunk: string) => output(chunk));
      child.stderr.setEncoding('utf8').on('data', (chunk: string) => output(chunk, true));
      child.on('error', (error) => {
        output(environmentTexts.main.pythonLaunchFailedOutput(error.message), true);
        finish(null);
      });
      child.on('close', (code, signal) => {
        if (finished) return;
        if (signal && !timedOut && !aborted) output(environmentTexts.main.pythonSignalOutput(signal), true);
        finish(timedOut || aborted ? null : code);
      });
      options.signal?.addEventListener('abort', abort, { once: true });
      if (options.signal?.aborted) abort();
    });
  }
}
