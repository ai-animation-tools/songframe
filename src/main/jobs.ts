/**
 * Длинные задания главного процесса: отправка и ожидание генерации, повтор, приёмка, сводка.
 * Каждое задание это последовательность вызовов инструментов Python; журнал пишется в localDir/jobs.
 * Рядом с <id>.log лежит <id>.json со сведениями без текста лога: журнал заданий переживает перезапуск и сбой программы.
 */

import { appendFileSync, closeSync, existsSync, fstatSync, mkdirSync, openSync, readdirSync, readSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { JOB_INTERRUPTED_MESSAGE, type JobInfo, type JobKind, type JobStepInfo } from '@shared/types';
import { readLocalJson, writeLocalJson } from './local-files';
import { PythonLauncher } from './python-launcher';

const LOG_TAIL = 12000;
const ERROR_LIMIT = 2000;
/** Сколько заданий прошлых сеансов хранится; более старые сведения удаляются вместе с журналами. */
export const SAVED_JOBS_LIMIT = 200;
/** Имя файла сведений задания инструментов; agent-<uuid>.json принадлежит заданиям агента. */
const JOB_FILE = /^([0-9a-z]+-\d+)\.json$/;
const JOB_STATUSES: JobInfo['status'][] = ['running', 'done', 'failed', 'interrupted'];
const STEP_STATUSES: JobStepInfo['status'][] = ['pending', 'running', 'done', 'failed'];

function isJobInfo(value: unknown, id: string): value is Omit<JobInfo, 'log'> {
  const job = value as Partial<JobInfo> | null;
  return (
    !!job &&
    job.id === id &&
    typeof job.kind === 'string' &&
    typeof job.title === 'string' &&
    JOB_STATUSES.includes(job.status as JobInfo['status']) &&
    typeof job.startedAt === 'string' &&
    (job.finishedAt === null || typeof job.finishedAt === 'string') &&
    (job.code === null || Number.isInteger(job.code)) &&
    Array.isArray(job.steps) &&
    job.steps.every((step) => !!step && typeof step.label === 'string' && typeof step.tool === 'string' && STEP_STATUSES.includes(step.status))
  );
}

/** Последние maxBytes журнала задания без чтения всего файла; отсутствующий файл даёт пустую строку. */
export function readLogTail(path: string, maxBytes: number): string {
  let fd: number;
  try {
    fd = openSync(path, 'r');
  } catch {
    return '';
  }
  try {
    const size = fstatSync(fd).size;
    const length = Math.min(size, maxBytes);
    const buffer = Buffer.alloc(length);
    readSync(fd, buffer, 0, length, size - length);
    // Обрезка могла попасть в середину многобайтного символа: заменитель в начале убираем.
    return buffer.toString('utf8').replace(/^\uFFFD+/, '');
  } finally {
    closeSync(fd);
  }
}

/**
 * Читает сведения прошлых сеансов: новые сверху, не больше limit; лишние сведения удаляются с журналами.
 * Задание, которое по сведениям выполнялось, помечается прерванным и сохраняется так. Повреждённый файл пропускается.
 */
export function loadSavedJobs(directory: string, limit = SAVED_JOBS_LIMIT, now = new Date()): JobInfo[] {
  if (!existsSync(directory)) return [];
  const jobs: JobInfo[] = [];
  for (const name of readdirSync(directory)) {
    const id = JOB_FILE.exec(name)?.[1];
    if (!id) continue;
    const file = join(directory, name);
    try {
      if (statSync(file).size > 1024 * 1024) throw new Error('размер');
      const saved = readLocalJson<unknown>(file);
      if (!isJobInfo(saved, id)) throw new Error('формат');
      jobs.push({ ...saved, log: '', previousSession: true });
    } catch {
      console.warn(`Не удалось прочитать сведения задания ${file}; файл пропущен.`);
    }
  }
  jobs.sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  for (const old of jobs.splice(limit)) {
    rmSync(join(directory, `${old.id}.json`), { force: true });
    rmSync(join(directory, `${old.id}.log`), { force: true });
  }
  for (const job of jobs) {
    if (job.status !== 'running') continue;
    job.status = 'interrupted';
    job.error = JOB_INTERRUPTED_MESSAGE;
    job.finishedAt = now.toISOString();
    for (const step of job.steps) if (step.status === 'running') step.status = 'failed';
    saveJob(directory, job);
  }
  return jobs;
}

/** Атомарная запись сведений без текста лога и признака прошлого сеанса; сбой записи не останавливает задание. */
function saveJob(directory: string, job: JobInfo): void {
  const { log: _log, previousSession: _previous, ...info } = job;
  try {
    writeLocalJson(join(directory, `${job.id}.json`), info);
  } catch (error) {
    console.warn(`Не удалось сохранить сведения задания: ${(error as Error).message}`);
  }
}

export interface Step {
  tool: string;
  args: string[];
  /** Ненулевой код шага делает задание неудачным (по умолчанию да); при false шаг лишь сопутствующий. */
  required?: boolean;
  /** Ненулевой код обязательного шага останавливает задание (по умолчанию да); при false идут следующие шаги. */
  stop?: boolean;
  label?: string;
  /** Лимит конкретной операции; ожидание провайдера генерации по умолчанию допускает до двух часов. */
  timeoutMs?: number;
  /** Проверка локального результата перед следующим шагом; ошибка останавливает обязательный шаг. */
  before?: () => void | Promise<void>;
}

export interface JobsOptions {
  /** Загрузить сведения прошлых сеансов (по умолчанию да); служебные проверки без окна их не трогают. */
  restore?: boolean;
  /** Смена ресурсов продолжает тот же журнал: выполняющиеся задания не объявляются прерванными. */
  previous?: Jobs;
}

export class Jobs {
  private readonly jobs: Map<string, JobInfo>;
  private readonly finishedListeners = new Set<(job: JobInfo, project: string | null) => void>();
  private counter = 0;
  private readonly directory: string;

  constructor(
    private readonly toolsRoot: string | null,
    localDir: string,
    readonly launcher = new PythonLauncher({ toolsRoot, localDir }),
    options: JobsOptions = {}
  ) {
    this.directory = join(localDir, 'jobs');
    if (options.previous) this.jobs = options.previous.jobs;
    else this.jobs = new Map(options.restore === false ? [] : loadSavedJobs(this.directory).map((job) => [job.id, job]));
  }

  list(): JobInfo[] {
    return [...this.jobs.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  /** Задание прошлого сеанса получает хвост журнала из файла: тексты всех логов в памяти не держатся. */
  get(id: string): JobInfo | null {
    const job = this.jobs.get(id);
    if (!job) return null;
    return job.previousSession ? { ...job, log: readLogTail(this.logPath(id), LOG_TAIL) } : job;
  }

  /** Полный журнал задания с диска (не больше maxBytes с конца) для копирования и отчёта. */
  readLog(id: string, maxBytes = 1024 * 1024): string {
    return this.jobs.has(id) ? readLogTail(this.logPath(id), maxBytes) : '';
  }

  logPath(id: string): string {
    return join(this.directory, `${id}.log`);
  }

  /** Подписчик получает завершённое задание и проект, выбранный при его запуске. */
  onFinished(listener: (job: JobInfo, project: string | null) => void): () => void {
    this.finishedListeners.add(listener);
    return () => {
      this.finishedListeners.delete(listener);
    };
  }

  /** Запускает шаги по очереди; падение обязательного шага завершает задание как неудачное. */
  start(kind: JobKind, title: string, project: string | null, steps: Step[]): JobInfo {
    if (!this.toolsRoot) throw new Error('Корень комплекса не найден: инструменты недоступны.');
    this.launcher.runtime();
    this.counter += 1;
    const id = `${Date.now().toString(36)}-${this.counter}`;
    const stepInfos: JobStepInfo[] = steps.map((step) => ({ label: step.label ?? step.tool, tool: step.tool, status: 'pending', code: null }));
    const job: JobInfo = {
      id,
      project,
      kind,
      title,
      status: 'running',
      startedAt: new Date().toISOString(),
      finishedAt: null,
      log: '',
      code: null,
      steps: stepInfos
    };
    this.jobs.set(id, job);
    mkdirSync(this.directory, { recursive: true });
    const logPath = this.logPath(id);
    const save = (): void => saveJob(this.directory, job);
    save();
    const write = (text: string): void => {
      appendFileSync(logPath, text);
      job.log = (job.log + text).slice(-LOG_TAIL);
    };
    const runStep = async (step: Step): Promise<{ code: number; error?: string }> => {
      write(`\n$ ${step.label ?? step.tool} ${step.args.join(' ')}\n`);
      try {
        await step.before?.();
        const result = await this.launcher.run(project, step.tool, step.args, { onOutput: write, timeoutMs: step.timeoutMs ?? 2 * 60 * 60 * 1000 });
        const code = result.code ?? -1;
        // Причина берётся из вывода именно этого шага: последующие шаги могут затереть хвост журнала.
        const error = result.stderr.trim() || result.stdout.trim() || `Шаг «${step.label ?? step.tool}» завершился с кодом ${code}.`;
        return { code, ...(code !== 0 ? { error: error.slice(-ERROR_LIMIT) } : {}) };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        write(`\nОшибка запуска: ${message}\n`);
        return { code: -1, error: message.slice(-ERROR_LIMIT) };
      }
    };
    void (async () => {
      let failed: number | null = null;
      for (const [index, step] of steps.entries()) {
        stepInfos[index].status = 'running';
        save();
        const { code, error } = await runStep(step);
        stepInfos[index].code = code;
        stepInfos[index].status = code === 0 ? 'done' : 'failed';
        save();
        if (code !== 0 && step.required !== false) {
          if (failed === null) job.error = error;
          failed = failed ?? code;
          if (step.stop !== false) {
            write(`\nШаг «${step.label ?? step.tool}» завершился с кодом ${code}; задание остановлено.\n`);
            break;
          }
          write(`\nШаг «${step.label ?? step.tool}» завершился с кодом ${code}.\n`);
        }
      }
      job.status = failed === null ? 'done' : 'failed';
      job.code = failed ?? 0;
      job.finishedAt = new Date().toISOString();
      save();
      for (const listener of this.finishedListeners) {
        try {
          // Отдельная копия защищает историю и остальных подписчиков от изменений снимка.
          listener(structuredClone(job), project);
        } catch {
          console.warn('Не удалось доставить завершение задания подписчику.');
        }
      }
    })();
    return job;
  }
}
