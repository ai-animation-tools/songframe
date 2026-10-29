/** Адаптеры знают только аргументы CLI и формат событий; жизненным циклом владеет AgentManager.
 * Новый CLI подключается записью в shared/agent-providers.ts, описанием проверки в agent-probes.ts и адаптером здесь. */
import type { AgentAccountResult, AgentCheckResult, AgentModel, AgentSettings } from '@shared/agents';
import type { AgentProvider } from '@shared/agent-providers';
import { checkAgent } from './agents';
import { claudeAccount, codexAccount } from './agent-account';
import { AgentError, providerFailure } from './agent-protocol';
import { readClaudeModels } from './claude-account-transport';
import type { AccountProcessOptions } from './codex-account-transport';
import { readCodexAgentModels } from './codex-models';

export type AgentUpdate =
  | { type: 'session'; id: string }
  | { type: 'text_delta'; text: string }
  | { type: 'tool_started' | 'tool_finished'; tool: string }
  | { type: 'completed'; result?: string }
  /** Нефатальное уведомление CLI (переподключение, предупреждение): задание продолжается. */
  | { type: 'notice'; message: string }
  | { type: 'failed'; error: AgentError };

/** read — только чтение проекта; write — запись кандидатов во временную рабочую папку задания. */
export type AgentRunMode = 'read' | 'write';

export interface AgentAdapter {
  readonly provider: AgentProvider;
  check(config: AgentSettings): Promise<AgentCheckResult>;
  account(config: AgentSettings): Promise<AgentAccountResult>;
  /** Каталог моделей найденного CLI служебным вызовом, без хода модели. */
  models(executable: string, options: AccountProcessOptions): Promise<AgentModel[]>;
  /** Неподдерживаемый режим или версия завершаются AgentError до запуска процесса. */
  args(config: AgentSettings, version: string, mode: AgentRunMode): string[];
  parse(value: Record<string, unknown>): AgentUpdate[];
}

function object(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
function text(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
function blocks(value: unknown): Record<string, unknown>[] {
  return Array.isArray(value) ? value.map(object) : [];
}
function session(value: unknown): AgentUpdate[] {
  const id = text(value);
  return /^[\w.-]{1,128}$/.test(id) ? [{ type: 'session', id }] : [];
}
const unsupportedMode = (): AgentError => new AgentError('UNSUPPORTED_VERSION', 'Выбранный агент не поддерживает штатный режим создания кандидатов.');

function supported(version: string, major: number, minor: number, patch: number): void {
  const match = /^(\d+)\.(\d+)\.(\d+)$/.exec(version);
  if (!match || +match[1] !== major || +match[2] < minor || (+match[2] === minor && +match[3] < patch)) {
    throw new AgentError(
      'UNSUPPORTED_VERSION',
      'Эта версия агента не поддерживает подтверждённый контракт запуска. Обновите агента или выберите совместимую версию.'
    );
  }
}

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = 'claude';
  private partial = false;
  private readonly tools = new Set<string>();
  check(config: AgentSettings): Promise<AgentCheckResult> {
    return checkAgent(config);
  }
  account(config: AgentSettings): Promise<AgentAccountResult> {
    return claudeAccount(config);
  }
  models(executable: string, options: AccountProcessOptions): Promise<AgentModel[]> {
    return readClaudeModels(executable, options);
  }
  args(config: AgentSettings, version: string, mode: AgentRunMode): string[] {
    supported(version, 2, 1, 0);
    if (mode !== 'read') throw unsupportedMode();
    return [
      '-p',
      '--input-format',
      'text',
      '--output-format',
      'stream-json',
      '--verbose',
      '--include-partial-messages',
      '--permission-mode',
      'dontAsk',
      '--tools',
      'Read,Glob,Grep',
      '--allowedTools',
      'Read,Glob,Grep',
      ...(config.model ? ['--model', config.model] : [])
    ];
  }
  parse(value: Record<string, unknown>): AgentUpdate[] {
    if (value.type === 'system' && value.subtype === 'init') return session(value.session_id);
    if (value.type === 'stream_event') {
      const event = object(value.event);
      const delta = object(event.delta);
      if (delta.type === 'text_delta' && typeof delta.text === 'string') {
        this.partial = true;
        return [{ type: 'text_delta', text: delta.text }];
      }
      return [];
    }
    if (value.type === 'assistant') {
      const updates: AgentUpdate[] = [];
      for (const block of blocks(object(value.message).content)) {
        if (block.type === 'text' && !this.partial) updates.push({ type: 'text_delta', text: text(block.text) });
        if (block.type === 'tool_use' && !this.tools.has(text(block.id))) {
          this.tools.add(text(block.id));
          updates.push({ type: 'tool_started', tool: text(block.name).slice(0, 100) });
        }
      }
      this.partial = false;
      return updates;
    }
    if (value.type === 'user')
      return blocks(object(value.message).content)
        .filter((block) => block.type === 'tool_result')
        .map(() => ({ type: 'tool_finished', tool: 'Чтение проекта' }));
    if (value.type === 'result') {
      if (value.is_error === true || value.subtype !== 'success')
        return [
          {
            type: 'failed',
            error: (() => {
              const reason = [
                value.subtype,
                value.result,
                ...(Array.isArray(value.errors) ? value.errors.filter((error) => typeof error === 'string') : [])
              ].join(' ');
              return providerFailure(reason, reason);
            })()
          }
        ];
      return [...session(value.session_id), { type: 'completed', result: text(value.result) }];
    }
    return [];
  }
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = 'codex';
  private readonly messages = new Map<string, string>();
  private completedMessage = '';
  check(config: AgentSettings): Promise<AgentCheckResult> {
    return checkAgent(config);
  }
  account(config: AgentSettings): Promise<AgentAccountResult> {
    return codexAccount(config);
  }
  models(executable: string, options: AccountProcessOptions): Promise<AgentModel[]> {
    return readCodexAgentModels(executable, options);
  }
  args(config: AgentSettings, version: string, mode: AgentRunMode): string[] {
    supported(version, 0, 159, 0);
    return [
      '-a',
      'never',
      'exec',
      '--json',
      '--sandbox',
      mode === 'write' ? 'workspace-write' : 'read-only',
      '--skip-git-repo-check',
      '--color',
      'never',
      ...(config.model ? ['--model', config.model] : []),
      '-'
    ];
  }
  parse(value: Record<string, unknown>): AgentUpdate[] {
    if (value.type === 'thread.started') return session(value.thread_id);
    if (value.type === 'turn.completed') return [{ type: 'completed', result: this.completedMessage }];
    // Фатален только turn.failed. Событие error верхнего уровня Codex шлёт и при переподключении потока,
    // после которого ход продолжается; если ход всё же оборвётся, менеджер покажет последнее уведомление.
    if (value.type === 'turn.failed') {
      const reason = object(value.error).message ?? value.message;
      return [{ type: 'failed', error: providerFailure(reason, reason) }];
    }
    if (value.type === 'error') return [{ type: 'notice', message: text(value.message ?? object(value.error).message) }];
    const item = object(value.item);
    if (value.type === 'item.completed' || value.type === 'item.updated' || value.type === 'item.started') {
      if (item.type === 'agent_message') {
        const id = text(item.id);
        const message = text(item.text);
        // Промежуточные сообщения остаются прогрессом; результатом служит последнее полное сообщение перед turn.completed.
        if (value.type === 'item.completed') this.completedMessage = message;
        const previous = this.messages.get(id) ?? '';
        this.messages.set(id, message);
        if (!message.startsWith(previous)) throw new AgentError('PROTOCOL_ERROR', 'Codex изменил уже полученный текст сообщения.');
        const delta = message.slice(previous.length);
        return delta ? [{ type: 'text_delta', text: `${!previous && this.messages.size > 1 ? '\n' : ''}${delta}` }] : [];
      }
      if (['command_execution', 'mcp_tool_call', 'web_search', 'file_change'].includes(text(item.type))) {
        return [{ type: value.type === 'item.completed' ? 'tool_finished' : 'tool_started', tool: text(item.type) }];
      }
      // Элемент error в codex exec — нефатальное уведомление; ход продолжается до turn.completed или turn.failed.
      if (item.type === 'error' && value.type === 'item.completed') return [{ type: 'notice', message: text(item.message) }];
    }
    return [];
  }
}

/** Record требует адаптера для каждого провайдера реестра; адаптер хранит состояние разбора одного задания. */
const ADAPTERS: Record<AgentProvider, () => AgentAdapter> = {
  claude: () => new ClaudeAdapter(),
  codex: () => new CodexAdapter()
};

export function createAgentAdapter(provider: AgentProvider): AgentAdapter {
  return ADAPTERS[provider]();
}
