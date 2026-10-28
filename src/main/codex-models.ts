/** Каталог моделей агента Codex читается штатным model/list; наличие image tool он не подтверждает. */
import { homedir } from 'node:os';
import type { AgentModel, AgentSettings } from '@shared/agents';
import type { MediaModel } from '@shared/media-providers';
import { AGENT_PROVIDERS } from '@shared/agent-providers';
import { agentEnvironment } from './agents';
import { withCodexAppServer, type AccountProcessOptions } from './codex-account-transport';

const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value);

interface CodexModelRow {
  model: string;
  displayName: string | null;
  isDefault: boolean;
}

async function codexModelRows(executable: string, options: AccountProcessOptions): Promise<CodexModelRow[]> {
  return withCodexAppServer(executable, options, async (request) => {
    const models = new Map<string, CodexModelRow>();
    const cursors = new Set<string>();
    let cursor: string | undefined;
    do {
      const result = await request('model/list', { limit: 100, includeHidden: false, ...(cursor ? { cursor } : {}) });
      if (
        !record(result) ||
        !Array.isArray(result.data) ||
        (result.nextCursor !== null && result.nextCursor !== undefined && typeof result.nextCursor !== 'string')
      )
        throw new Error('Codex вернул неизвестный формат каталога моделей.');
      for (const item of result.data) {
        if (!record(item) || typeof item.model !== 'string' || !item.model.trim()) throw new Error('Codex вернул модель без точного имени.');
        if (item.hidden === true) continue;
        // В exec передаётся именно model из объявления; displayName не является идентификатором CLI.
        models.set(item.model, {
          model: item.model,
          displayName: typeof item.displayName === 'string' && item.displayName.trim() ? item.displayName.trim().slice(0, 128) : null,
          isDefault: item.isDefault === true
        });
      }
      cursor = typeof result.nextCursor === 'string' && result.nextCursor ? result.nextCursor : undefined;
      if (cursor && cursors.has(cursor)) throw new Error('Codex повторил страницу каталога моделей.');
      if (cursor) cursors.add(cursor);
    } while (cursor);
    return [...models.values()];
  });
}

/** Модели агента для опор: каталог провайдера изображений Codex. */
export async function readCodexModels(config: AgentSettings, options: Partial<AccountProcessOptions> = {}): Promise<MediaModel[]> {
  if (config.provider !== 'codex') throw new Error('Каталог моделей доступен только для агента Codex.');
  const home = options.home ?? homedir();
  const rows = await codexModelRows(AGENT_PROVIDERS.codex.executable, { ...options, home, env: agentEnvironment(options.env, home) });
  return rows.map((row) => ({ id: row.model, command: 'codex_exec', arguments: {}, slots: {}, limits: {} }));
}

/** Модели текстового агента для выбора в настройках. */
export async function readCodexAgentModels(executable: string, options: AccountProcessOptions): Promise<AgentModel[]> {
  const rows = await codexModelRows(executable, options);
  return rows.map((row) => ({ id: row.model, label: row.displayName ?? row.model, ...(row.isDefault ? { isDefault: true } : {}) }));
}
