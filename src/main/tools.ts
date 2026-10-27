/** Запуск инструментов комплекса на Python с явным проектом. */

import type { ToolResult } from '@shared/types';
import { PythonLauncher, TOOL_TIMEOUT } from './python-launcher';

/** Контракт IPC сохранён, а способ запуска общий с длинными заданиями. */
export function runTool(
  toolsRoot: string | null,
  project: string,
  name: string,
  args: string[],
  timeoutMs = TOOL_TIMEOUT,
  launcher = new PythonLauncher({ toolsRoot })
): Promise<ToolResult> {
  return launcher.run(project, name, args, { timeoutMs });
}
