/** Каталог моделей агента Codex читается штатным model/list; наличие image tool он не подтверждает. */
import { homedir } from 'node:os';
import type { AgentSettings } from '@shared/agents';
import type { MediaModel } from '@shared/media-providers';
import { agentEnvironment } from './agents';
import { withCodexAppServer, type AccountProcessOptions } from './codex-account-transport';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

export async function readCodexModels(config: AgentSettings, options: Partial<AccountProcessOptions> = {}): Promise<MediaModel[]> {
  if (config.provider !== 'codex') throw new Error('Каталог моделей доступен только для агента Codex.');
  const home = options.home ?? homedir();
  return withCodexAppServer(config.executablePath?.trim() || 'codex', { ...options, home, env: agentEnvironment(options.env, home) }, async (request) => {
    const models = new Map<string, MediaModel>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (
        !record(result) ||
        !Array.isArray(result.data) ||
        (result.nextCursor !== null && result.nextCursor !== undefined && typeof result.nextCursor !== 'string')
      )
        throw new Error('CLI вернул неизвестный формат каталога моделей Codex.');
      for (const item of result.data) {
        if (!record(item) || typeof item.model !== 'string' || !item.model.trim()) throw new Error('CLI вернул модель Codex без точного имени.');
        if (item.hidden === true) continue;
        // В exec передаётся именно model из объявления; displayName не является идентификатором CLI.
        models.set(item.model, { id: item.model, command: 'codex_exec', arguments: {}, slots: {}, limits: {} });
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error('CLI повторил страницу каталога моделей Codex.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...models.values()];
  });
}
