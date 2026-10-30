/**
 * Журнал сбоев приложения, файл сеанса и отчёт для разработчика. Логика не зависит от Electron и проверяется тестами;
 * подключение к событиям процесса и окон — в app-diagnostics.ts.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, statSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentJob } from '@shared/agents';
import type { JobInfo, PreviousSessionInfo } from '@shared/types';
import { redact } from './agent-protocol';
import { readLocalJson, writeLocalJson } from './local-files';

/** При превышении журнал переименовывается в app.1.log; хранится одна предыдущая копия. */
export const CRASH_LOG_LIMIT = 1024 * 1024;
export const REPORT_LIMIT = 5 * 1024 * 1024;
export const REPORT_JOBS = 50;
export const REPORT_AGENT_JOBS = 20;
export const REPORT_LOG_LINES = 200;
/** Одна запись журнала сбоев: длинный стек renderer не вытесняет остальные события. */
const ENTRY_LIMIT = 16 * 1024;

export interface RuntimeInfo {
  app: string;
  electron: string;
  node: string;
  /** Платформа и версия ядра, например «linux 6.8.0». */
  os: string;
  arch: string;
  packaged: boolean;
}

export interface SessionRecord {
  startedAt: string;
  version: string;
  pid: number;
  clean: boolean;
}

export function logsDir(localDir: string): string {
  return join(localDir, 'logs');
}

/** Домашний каталог заменяется на «~»: в журнале и отчёте не остаётся имени пользователя. */
export function hideHome(text: string, home = homedir()): string {
  if (!home || home.length < 2) return text;
  let result = text;
  for (const variant of new Set([home, home.replace(/\\/g, '/')])) result = result.split(variant).join('~');
  return result;
}

/** Текст для журнала и отчёта: без домашнего каталога и похожих на токены значений. */
export function sanitize(text: string, home?: string): string {
  return redact(hideHome(text, home));
}

export function runtimeLine(info: RuntimeInfo): string {
  // eslint-disable-next-line no-restricted-syntax -- Строка версий относится к формату журнала и отчёта разработчика, а не к UI.
  return `SongFrame ${info.app}; Electron ${info.electron}; Node ${info.node}; ОС ${info.os}; архитектура ${info.arch}; ${info.packaged ? 'готовая поставка' : 'запуск из checkout'}`;
}

/** Журнал сбоев localDir/logs/app.log: строка «время [вид] текст», продолжение стека с отступом. */
export class CrashLog {
  readonly path: string;
  readonly previousPath: string;
  constructor(
    readonly localDir: string,
    private readonly options: { limit?: number; home?: string; now?: () => Date } = {}
  ) {
    this.path = join(logsDir(localDir), 'app.log');
    this.previousPath = join(logsDir(localDir), 'app.1.log');
  }

  write(kind: string, text: string): void {
    try {
      mkdirSync(logsDir(this.localDir), { recursive: true });
      if (existsSync(this.path) && statSync(this.path).size > (this.options.limit ?? CRASH_LOG_LIMIT)) renameSync(this.path, this.previousPath);
      const body = sanitize(text, this.options.home).trimEnd().slice(0, ENTRY_LIMIT).split(/\r?\n/).join('\n    ');
      appendFileSync(this.path, `${(this.options.now?.() ?? new Date()).toISOString()} [${kind}] ${body}\n`);
    } catch (error) {
      // Недоступный журнал не должен становиться ещё одним сбоем.
      // eslint-disable-next-line no-restricted-syntax -- Внутренний отказ записи журнала выводится только в консоль процесса.
      console.error('Не удалось записать журнал сбоев:', error);
    }
  }
}

/** Текст ошибки со стеком для журнала; причина (cause) добавляется отдельной строкой. */
export function describeFailure(value: unknown): string {
  if (value instanceof Error) {
    const text = value.stack || `${value.name}: ${value.message}`;
    // eslint-disable-next-line no-restricted-syntax -- Причина ошибки дополняет стек только в журнале сбоев и отчёте разработчика.
    return value.cause !== undefined ? `${text}\nПричина: ${describeFailure(value.cause)}` : text;
  }
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

/**
 * Начало сеанса: читает прошлый session.json и записывает новый с clean:false.
 * Прошлый сеанс без clean:true считается завершённым аварийно; повреждённый файл означает, что сведений нет.
 */
export function beginSession(
  localDir: string,
  current: Omit<SessionRecord, 'clean'>
): { record: SessionRecord; previous: SessionRecord | null; crashed: boolean } {
  const path = join(logsDir(localDir), 'session.json');
  let previous: SessionRecord | null = null;
  try {
    const saved = readLocalJson<Partial<SessionRecord>>(path);
    if (saved && typeof saved.startedAt === 'string' && typeof saved.clean === 'boolean')
      previous = { startedAt: saved.startedAt, version: String(saved.version ?? ''), pid: Number(saved.pid ?? 0), clean: saved.clean };
  } catch {
    previous = null;
  }
  const record: SessionRecord = { ...current, clean: false };
  writeLocalJson(path, record);
  return { record, previous, crashed: !!previous && !previous.clean };
}

/** Штатный выход помечает сеанс чистым. */
export function endSession(localDir: string, record: SessionRecord): void {
  writeLocalJson(join(logsDir(localDir), 'session.json'), { ...record, clean: true });
}

export function previousSessionInfo(previous: SessionRecord | null, crashed: boolean): PreviousSessionInfo {
  return { crashed, startedAt: previous?.startedAt ?? null, version: previous?.version || null };
}

function lastLines(text: string, count: number): string {
  const lines = text.replace(/\s+$/, '').split('\n');
  return lines.length > count ? lines.slice(-count).join('\n') : lines.join('\n');
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/* eslint-disable no-restricted-syntax -- Сводка и копия задания сохраняют служебный формат журнала и отчёта разработчика. */
function jobInfo(job: JobInfo): string {
  const lines = [
    `Задание ${job.id}: ${job.title}`,
    `Вид: ${job.kind}; проект: ${job.project ?? 'общее задание приложения'}; статус: ${job.status}; код: ${job.code ?? '—'}`,
    `Начато: ${job.startedAt}; завершено: ${job.finishedAt ?? '—'}${job.previousSession ? '; прошлый сеанс' : ''}`
  ];
  if (job.steps.length)
    lines.push('Шаги:', ...job.steps.map((step) => `  ${step.label} (${step.tool}): ${step.status}${step.code === null ? '' : `, код ${step.code}`}`));
  if (job.error) lines.push(`Ошибка: ${job.error}`);
  return lines.join('\n');
}

/** Сведения задания и его журнал одним текстом для буфера обмена; домашний каталог и токены скрыты, как в отчёте. */
export function jobText(job: JobInfo, log: string, home?: string): string {
  return sanitize(`${jobInfo(job)}\n\nЖурнал:\n${log.trim() || 'Журнал пуст.'}\n`, home);
}

/* eslint-enable no-restricted-syntax */

export interface ReportInput {
  localDir: string;
  info: RuntimeInfo;
  previous: PreviousSessionInfo;
  /** Задания инструментов, новые сверху. */
  jobs: JobInfo[];
  /** Журнал задания с конца; отчёт берёт из него последние строки. */
  readLog: (id: string) => string;
  agents: AgentJob[];
  now?: Date;
  home?: string;
  limit?: number;
}

/**
 * Один текстовый отчёт для разработчика. Не включает settings.json, файлы входа провайдеров, промпты и вывод агента;
 * домашний каталог заменён на «~». Журналы заданий добавляются, пока отчёт не превысит limit.
 */
/* eslint-disable no-restricted-syntax -- Содержимое текстового отчёта разработчика сохраняет свой формат и владельца согласно docs/ui/texts.md. */
export function buildReport(input: ReportInput): string {
  const limit = input.limit ?? REPORT_LIMIT;
  const clean = (text: string): string => sanitize(text, input.home);
  const previous = input.previous.crashed
    ? `завершился аварийно (начат ${input.previous.startedAt ?? '—'}, версия ${input.previous.version ?? '—'})`
    : input.previous.startedAt
      ? `завершился штатно (начат ${input.previous.startedAt})`
      : 'сведений нет';
  const header = [
    'SongFrame: отчёт для разработчика',
    `Создан: ${(input.now ?? new Date()).toISOString()}`,
    runtimeLine(input.info),
    `Каталог состояния: ${input.localDir}`,
    `Прошлый сеанс: ${previous}`
  ].join('\n');

  const crashParts: string[] = [];
  for (const [name, path] of [
    ['app.1.log', join(logsDir(input.localDir), 'app.1.log')],
    ['app.log', join(logsDir(input.localDir), 'app.log')]
  ]) {
    const text = readText(path);
    if (text !== null) crashParts.push(`--- logs/${name} ---\n${text.trimEnd()}`);
  }
  const crash = `== Журнал сбоев ==\n${crashParts.join('\n\n') || 'Записей нет.'}`;

  const agents = input.agents
    .slice(0, REPORT_AGENT_JOBS)
    .map((job) =>
      [
        job.id,
        `задача: ${job.task}`,
        `провайдер: ${job.provider}`,
        `статус: ${job.status}`,
        `начато: ${job.startedAt}`,
        `завершено: ${job.finishedAt ?? '—'}`,
        `код выхода: ${job.exitCode ?? '—'}`,
        ...(job.diagnostic ? [`диагностика: ${job.diagnostic}`] : [])
      ].join('; ')
    );
  const agentSection = `== Задания агента (последние ${REPORT_AGENT_JOBS}, без промптов и вывода) ==\n${agents.join('\n') || 'Заданий нет.'}`;

  const head = clean(`${header}\n\n${crash}`);
  const tail = clean(agentSection);
  let budget = limit - Buffer.byteLength(head) - Buffer.byteLength(tail) - 1024;
  const jobParts: string[] = [];
  for (const job of input.jobs.slice(0, REPORT_JOBS)) {
    const part = clean(
      `${jobInfo(job)}\nЖурнал (последние ${REPORT_LOG_LINES} строк):\n${lastLines(input.readLog(job.id), REPORT_LOG_LINES) || 'Журнал пуст.'}`
    );
    const bytes = Buffer.byteLength(part) + 2;
    if (bytes > budget) {
      const size = limit >= 1024 * 1024 ? `${Math.round(limit / 1024 / 1024)} МБ` : `${Math.round(limit / 1024)} КБ`;
      jobParts.push(`Отчёт ограничен ${size}: журналы остальных заданий не включены.`);
      break;
    }
    budget -= bytes;
    jobParts.push(part);
  }
  const jobsSection = `== Задания инструментов (последние ${REPORT_JOBS}) ==\n${jobParts.join('\n\n') || 'Заданий нет.'}`;
  const report = `${head}\n\n${jobsSection}\n\n${tail}\n`;
  // Журнал сбоев сам ограничен 2 МБ, но итог всё равно не превышает лимит.
  return Buffer.byteLength(report) > limit ? Buffer.from(report).subarray(0, limit).toString('utf8') : report;
}
/* eslint-enable no-restricted-syntax */
