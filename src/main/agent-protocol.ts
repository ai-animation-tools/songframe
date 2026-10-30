/** JSONL разбирается по строкам, независимо от границ буферов и многобайтовых символов UTF-8. */
import { agentsTexts } from '@shared/texts/agents';
import { StringDecoder } from 'node:string_decoder';
import type { AgentDiagnosticCode } from '@shared/agents';

export class AgentError extends Error {
  constructor(
    readonly code: AgentDiagnosticCode,
    readonly detail: string
  ) {
    super(`[${code}] ${detail}`);
  }
}

export class JsonLines {
  private readonly decoder = new StringDecoder('utf8');
  private pending = '';

  constructor(
    private readonly onValue: (value: Record<string, unknown>) => void,
    private readonly lineBytes = 256 * 1024
  ) {}

  push(chunk: Buffer): void {
    this.pending += this.decoder.write(chunk);
    let end: number;
    while ((end = this.pending.indexOf('\n')) >= 0) {
      const line = this.pending.slice(0, end);
      this.pending = this.pending.slice(end + 1);
      this.parse(line);
    }
    this.checkSize(this.pending);
  }

  finish(): void {
    this.pending += this.decoder.end();
    if (this.pending.trim()) this.parse(this.pending);
    this.pending = '';
  }

  private checkSize(line: string): void {
    if (Buffer.byteLength(line) > this.lineBytes) throw new AgentError('OUTPUT_LIMIT', agentsTexts.lineTooLarge);
  }

  private parse(line: string): void {
    this.checkSize(line);
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new AgentError('PROTOCOL_ERROR', agentsTexts.invalidJsonLines);
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError('PROTOCOL_ERROR', agentsTexts.eventObjectRequired);
    this.onValue(value as Record<string, unknown>);
  }
}

/** В журнал не попадает сырой CLI output; в тексте результата убираем распознаваемые секреты. */
export function redact(text: string): string {
  // Маркеры редактирования входят в очищенные результаты и журналы; их формат не является UI-подписью.
  return (
    text
      // eslint-disable-next-line no-restricted-syntax -- Служебный маркер замены секрета сохраняется дословно.
      .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~-]+)/gi, '[скрыто]')
      // eslint-disable-next-line no-restricted-syntax -- Подстановка $1 сохраняет имя поля перед служебным маркером.
      .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[скрыто]')
  );
}

const DETAIL_LIMIT = 400;

/** Текст причины от CLI для показа: без секретов, в одну строку и ограниченной длины. */
export function providerDetail(value: unknown): string {
  const text = typeof value === 'string' ? redact(value).replace(/\s+/g, ' ').trim() : '';
  return text.length > DETAIL_LIMIT ? `${text.slice(0, DETAIL_LIMIT)}…` : text;
}

/**
 * value служит только для классификации (в нём может быть stderr); detail — структурированное сообщение
 * агента о сбое, которое показывается пользователю, чтобы причина не терялась за общей фразой.
 */
export function providerFailure(value: unknown, detail?: unknown): AgentError {
  const text = typeof value === 'string' ? value : '';
  const reason = providerDetail(detail);
  if (/auth|not logged|login|unauthorized|invalid.?api.?key|\b401\b/i.test(text))
    return new AgentError('AUTH_REQUIRED', agentsTexts.authorizationFailed({ reason }));
  if (/rate.?limit|quota|usage.?limit|budget|\b429\b/i.test(text)) return new AgentError('RATE_LIMIT', agentsTexts.rateLimited({ reason }));
  return new AgentError('CLI_ERROR', agentsTexts.taskFailed({ reason }));
}
