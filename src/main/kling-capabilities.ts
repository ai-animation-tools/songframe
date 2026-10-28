/** Единый свежий снимок Kling для настроек и производства; завершённые ответы не кэшируются. */
import type { PythonLauncher } from './python-launcher';

export const KLING_COMMANDS = ['text_to_image', 'image_to_image', 'text_to_video', 'image_to_video', 'omni_ref_video', 'motion_control'];
interface Catalog {
  reports: { command: string; models: Record<string, unknown> }[];
  problems: { command: string; message: string }[];
}
type Launcher = Pick<PythonLauncher, 'run'>;
const pending = new WeakMap<Launcher, Map<string, Promise<Catalog>>>();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseCatalog(value: unknown): Catalog {
  if (!record(value) || !Array.isArray(value.reports) || !Array.isArray(value.problems)) throw new Error('Kling вернул неверное объявление возможностей.');
  const seen = new Set<string>();
  for (const [entries, failed] of [
    [value.reports, false],
    [value.problems, true]
  ] as const) {
    for (const entry of entries) {
      if (
        !record(entry) ||
        typeof entry.command !== 'string' ||
        !KLING_COMMANDS.includes(entry.command) ||
        seen.has(entry.command) ||
        (failed ? typeof entry.message !== 'string' || !entry.message.trim() : !record(entry.models))
      )
        throw new Error('Kling вернул неверный состав команд возможностей.');
      seen.add(entry.command);
    }
  }
  if (seen.size !== KLING_COMMANDS.length) throw new Error('Kling вернул неполный состав команд возможностей.');
  return value as unknown as Catalog;
}

export async function readKlingCapabilities(launcher: Launcher, project: string, cliArgs: string[], commands: string[]): Promise<Catalog> {
  if (!commands.length || new Set(commands).size !== commands.length || commands.some((command) => !KLING_COMMANDS.includes(command)))
    throw new Error('Неизвестный набор команд Kling.');
  let requests = pending.get(launcher);
  if (!requests) {
    requests = new Map();
    pending.set(launcher, requests);
  }
  // Две панели, StrictMode и возвращение на страницу ждут один текущий запрос к аккаунту.
  // После успеха или ошибки следующий вызов обязательно получает новый каталог.
  const key = JSON.stringify([project, cliArgs]);
  let request = requests.get(key);
  if (!request) {
    request = (async () => {
      const result = await launcher.run(
        project,
        'kling_request',
        ['capabilities', '--commands', KLING_COMMANDS.join(','), '--json', '--timeout', '30', ...cliArgs],
        { timeoutMs: 35_000 }
      );
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'Kling не подтвердил возможности.');
      return parseCatalog(JSON.parse(result.stdout));
    })().finally(() => {
      requests.delete(key);
    });
    requests.set(key, request);
  }
  const catalog = await request;
  return {
    reports: catalog.reports.filter((entry) => commands.includes(entry.command)),
    problems: catalog.problems.filter((entry) => commands.includes(entry.command))
  };
}
