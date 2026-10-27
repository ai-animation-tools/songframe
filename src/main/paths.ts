/** Где лежит комплекс (tools, templates) и где хранить локальное состояние приложения. */

import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

const MARKER = join('tools', 'common.py');

/** Поднимается от каждой стартовой папки вверх, пока не найдёт tools/common.py. */
export function findToolsRoot(candidates: (string | undefined)[]): string | null {
  for (const start of candidates) {
    if (!start) continue;
    let current = resolve(start);
    for (let depth = 0; depth < 8; depth += 1) {
      if (existsSync(join(current, MARKER))) return current;
      const parent = dirname(current);
      if (parent === current) break;
      current = parent;
    }
  }
  return null;
}

export interface AppPaths {
  toolsRoot: string | null;
  resourcesRoot: string | null;
  runtimeRoot: string | null;
  problems: string[];
  localDir: string;
}

/**
 * В разработке ресурсы находятся рядом с checkout; в поставке только в resourcesPath.
 * Логи packaged-приложения не пишутся в read-only AppImage. @link ../../scripts/runtime/README.md
 */
export function resolvePaths(options: {
  appPath: string;
  execPath: string;
  cwd: string;
  userData: string;
  portableDir?: string;
  packaged?: boolean;
  resourcesPath?: string;
  override?: string | null;
  /** SONGFRAME_LOCAL_DIR: отдельное локальное состояние, например для прогонов и тестов. */
  localDirOverride?: string;
}): AppPaths {
  const localDir = resolve(options.localDirOverride || options.userData);
  let toolsRoot: string | null;
  const problems: string[] = [];
  if (options.packaged) {
    const resources = options.resourcesPath;
    toolsRoot = resources && existsSync(join(resources, MARKER)) ? resources : null;
  } else if (options.override) {
    // Явный выбор проверяется точно: поиск вверх может незаметно выбрать другой checkout.
    toolsRoot = existsSync(join(options.override, MARKER)) ? resolve(options.override) : null;
    if (!toolsRoot) problems.push(`Сохранённая папка комплекса недоступна: ${options.override}. Выберите её заново на странице «Среда».`);
  } else {
    toolsRoot = findToolsRoot([options.appPath, dirname(options.execPath), options.cwd]);
  }
  return {
    toolsRoot,
    resourcesRoot: toolsRoot,
    runtimeRoot: toolsRoot ? (options.packaged ? join(toolsRoot, 'runtime') : join(toolsRoot, 'build/runtime', `${process.platform}-${process.arch}`)) : null,
    localDir,
    problems
  };
}
