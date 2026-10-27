/** Режим приложения без окна для проектного launcher; выполнение остаётся в общем PythonLauncher. */
import type { PythonLauncher } from './python-launcher';

export async function runToolCli(launcher: PythonLauncher, args: string[], output: (text: string, error?: boolean) => void): Promise<number> {
  const [name, ...toolArgs] = args;
  if (!name || !/^[a-z_]+$/.test(name)) {
    output('Использование: --songframe-tool <имя инструмента> [--project <папка>] [аргументы]\n', true);
    return 2;
  }
  try {
    // Выбор проекта выполняет common.py: сохраняется аргумент → окружение → файл → cwd.
    const result = await launcher.run(null, name, toolArgs, { timeoutMs: 2 * 60 * 60 * 1000, onOutput: output });
    return result.code ?? 1;
  } catch (error) {
    output(`Не удалось запустить ${name}: ${(error as Error).message}\n`, true);
    return 1;
  }
}
