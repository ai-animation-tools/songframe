/** Выбор поставляемого Python; системный интерпретатор допустим только при разработке. @link ../../scripts/runtime/README.md */

import { environmentTexts } from '@shared/texts/environment';
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { mediaPaths, modelDirectory } from './media-runtime';

export interface PythonOptions {
  packaged?: boolean;
  resourcesPath?: string;
  toolsRoot: string | null;
  localDir?: string;
  platform?: NodeJS.Platform;
  arch?: string;
  env?: NodeJS.ProcessEnv;
}

export interface PythonRuntime {
  source: 'bundled' | 'system-dev';
  command: string;
  argsPrefix: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  version: string;
}

/** Не наследует чужой venv и user site; вложенный sys.executable остаётся в том же runtime. */
export function pythonEnv(options: PythonOptions): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...(options.env ?? process.env),
    PYTHONIOENCODING: 'utf-8',
    PYTHONUTF8: '1',
    PYTHONUNBUFFERED: '1',
    PYTHONNOUSERSITE: '1',
    PYTHONDONTWRITEBYTECODE: '1'
  };
  delete env.PYTHONHOME;
  delete env.PYTHONPATH;
  delete env.VIRTUAL_ENV;
  if (options.localDir) env.SONGFRAME_LOCAL_DIR = options.localDir;
  const media = mediaPaths(options);
  if (media) {
    // Все медиатулы и вложенные процессы сначала находят бинарники поставки.
    env.PATH = [media.binDir, env.PATH].filter(Boolean).join((options.platform ?? process.platform) === 'win32' ? ';' : ':');
    env.SONGFRAME_BIN_DIR = media.binDir;
  }
  env.SONGFRAME_MODEL_DIR = modelDirectory(options);
  return env;
}

export function probePython(runtime: Pick<PythonRuntime, 'command' | 'argsPrefix' | 'cwd' | 'env'>, code: string): string {
  const result = spawnSync(runtime.command, [...runtime.argsPrefix, '-c', code], {
    cwd: runtime.cwd,
    env: runtime.env,
    encoding: 'utf-8',
    timeout: 30000,
    windowsHide: true,
    shell: false
  });
  if (result.error || result.status !== 0)
    throw new Error((result.stderr || result.error?.message || environmentTexts.main.pythonExited(result.status)).trim());
  return result.stdout.trim();
}

/** Пути вычисляются при запуске; packaged никогда не подменяет сломанную поставку Python из PATH. */
export function resolvePython(options: PythonOptions): PythonRuntime {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const target = `${platform}-${arch}`;
  const cwd = options.toolsRoot ? resolve(options.toolsRoot) : (options.resourcesPath ?? process.cwd());
  const env = pythonEnv(options);
  const root = options.packaged ? join(options.resourcesPath ?? '', 'runtime') : join(cwd, 'build', 'runtime', target);
  if (options.packaged || existsSync(root)) {
    try {
      const manifest = JSON.parse(readFileSync(join(root, 'manifest.json'), 'utf-8')) as { target: string; python: string };
      if (manifest.target !== target) throw new Error(environmentTexts.main.runtimeTargetMismatch({ actual: manifest.target, expected: target }));
      const command = join(root, 'python', platform === 'win32' ? 'python.exe' : 'bin/python3');
      if (!existsSync(command)) throw new Error(environmentTexts.main.runtimeFileMissing(command));
      return { source: 'bundled', command, argsPrefix: ['-B', '-X', 'utf8'], cwd, env, version: manifest.python };
    } catch (error) {
      throw new Error(environmentTexts.main.bundledPythonUnavailable({ root, reason: (error as Error).message }), { cause: error });
    }
  }
  const candidates = platform === 'win32' ? [['python'], ['py', '-3'], ['python3']] : [['python3'], ['python']];
  for (const [command, ...prefix] of candidates) {
    try {
      const base = { command, argsPrefix: prefix, cwd, env };
      const info = JSON.parse(
        probePython(base, 'import sys,json; print(json.dumps([sys.executable,sys.version_info.major,sys.version_info.minor,sys.version.split()[0]]))')
      ) as [string, number, number, string];
      if (info[1] === 3 && info[2] >= 11) return { ...base, command: info[0], argsPrefix: ['-B', '-X', 'utf8'], source: 'system-dev', version: info[3] };
    } catch {
      // Следующий кандидат нужен только разработчику; отсутствие не кэшируется навсегда.
    }
  }
  throw new Error(environmentTexts.main.developmentPythonMissing);
}
