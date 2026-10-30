/** Единый свежий каталог моделей платного провайдера для настроек и производства; завершённые ответы не кэшируются. */
import { mediaProviderTitle, type MediaKind } from '@shared/media-providers';
import { mediaTexts } from '@shared/texts/media';
import type { PythonLauncher } from './python-launcher';

export interface MediaCatalog {
  reports: { command: string; models: Record<string, unknown> }[];
  problems: { command: string; message: string }[];
}
type Launcher = Pick<PythonLauncher, 'run'>;
const pending = new WeakMap<Launcher, Map<string, Promise<MediaCatalog>>>();
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

function parseCatalog(value: unknown, title: string): MediaCatalog {
  if (!record(value) || !Array.isArray(value.reports) || !Array.isArray(value.problems)) throw new Error(mediaTexts.invalidCapabilities(title));
  const seen = new Set<string>();
  for (const [entries, failed] of [
    [value.reports, false],
    [value.problems, true]
  ] as const) {
    for (const entry of entries) {
      if (
        !record(entry) ||
        typeof entry.command !== 'string' ||
        !entry.command ||
        seen.has(entry.command) ||
        (failed ? typeof entry.message !== 'string' || !entry.message.trim() : !record(entry.models))
      )
        throw new Error(mediaTexts.invalidCapabilityCommands(title));
      seen.add(entry.command);
    }
  }
  return value as unknown as MediaCatalog;
}

/** Команды вида медиа знает адаптер провайдера в Python; приложение получает объявления и ошибки по командам. */
export async function readMediaCatalog(launcher: Launcher, project: string, provider: string, kind: MediaKind): Promise<MediaCatalog> {
  let requests = pending.get(launcher);
  if (!requests) {
    requests = new Map();
    pending.set(launcher, requests);
  }
  // Две панели, StrictMode и возвращение на страницу ждут один текущий запрос к аккаунту.
  // После успеха или ошибки следующий вызов обязательно получает новый каталог.
  const key = JSON.stringify([project, provider, kind]);
  let request = requests.get(key);
  if (!request) {
    const title = mediaProviderTitle(provider, provider);
    request = (async () => {
      const result = await launcher.run(project, 'media_request', ['capabilities', '--provider', provider, '--kind', kind, '--json', '--timeout', '30'], {
        timeoutMs: 35_000
      });
      if (result.code !== 0) throw new Error(result.stderr.trim() || mediaTexts.capabilitiesNotConfirmed(title));
      return parseCatalog(JSON.parse(result.stdout), title);
    })().finally(() => {
      requests.delete(key);
    });
    requests.set(key, request);
  }
  return request;
}

/** Есть ли у какой-нибудь модели аккаунта звуковой вход: без него точный липсинк по WAV невозможен. */
export function acceptsAudioInput(reports: unknown[]): boolean {
  return reports.some((report) =>
    Object.values(record(report) && record(report.models) ? report.models : {}).some((model) => {
      const slots = record(model) && record(model.slots) ? Object.keys(model.slots) : [];
      return slots.some((slot) => /audio|voice|sound/i.test(slot));
    })
  );
}
