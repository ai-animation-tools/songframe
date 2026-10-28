/** JSONL разбирается по строкам, независимо от границ буферов и многобайтовых символов UTF-8. */
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
    if (Buffer.byteLength(line) > this.lineBytes) throw new AgentError('OUTPUT_LIMIT', 'Строка ответа агента слишком велика.');
  }

  private parse(line: string): void {
    this.checkSize(line);
    if (!line.trim()) return;
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new AgentError('PROTOCOL_ERROR', 'Агент вернул некорректный JSONL.');
    }
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError('PROTOCOL_ERROR', 'Ожидался объект события агента.');
    this.onValue(value as Record<string, unknown>);
  }
}

/** В журнал не попадает сырой CLI output; в тексте результата убираем распознаваемые секреты. */
export function redact(text: string): string {
  return text
    .replace(/\b(?:sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~-]+)/gi, '[скрыто]')
    .replace(/((?:api[_-]?key|access[_-]?token|refresh[_-]?token|authorization)\s*[=:]\s*["']?)[^\s,"'}]+/gi, '$1[скрыто]');
}

export function providerFailure(value: unknown): AgentError {
  const text = typeof value === 'string' ? value : '';
  if (/auth|not logged|login|unauthorized|invalid.?api.?key|\b401\b/i.test(text))
    return new AgentError('AUTH_REQUIRED', 'Агент сообщил об ошибке входа. Проверьте авторизацию в настройках.');
  if (/rate.?limit|quota|usage.?limit|budget|\b429\b/i.test(text))
    return new AgentError('RATE_LIMIT', 'Агент сообщил об ограничении использования. Проверьте лимиты аккаунта.');
  return new AgentError('CLI_ERROR', 'Агент сообщил об ошибке задания. Проверьте его настройки и доступность выбранной модели.');
}
