/**
 * Длинные задания главного процесса: отправка и ожидание генерации, повтор, приёмка, сводка.
 * Каждое задание это последовательность вызовов инструментов Python; журнал пишется в localDir/jobs.
 */

import { appendFileSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type { JobInfo, JobKind, JobStepInfo } from '@shared/types';
import { PythonLauncher } from './python-launcher';

const LOG_TAIL = 12000;
const ERROR_LIMIT = 2000;

export interface Step {
  tool: string;
  args: string[];
  /** Ненулевой код шага делает задание неудачным (по умолчанию да); при false шаг лишь сопутствующий. */
  required?: boolean;
  /** Ненулевой код обязательного шага останавливает задание (по умолчанию да); при false идут следующие шаги. */
  stop?: boolean;
  label?: string;
  /** Лимит конкретной операции; ожидание Kling по умолчанию допускает до двух часов. */
  timeoutMs?: number;
  /** Проверка локального результата перед следующим шагом; ошибка останавливает обязательный шаг. */
  before?: () => void | Promise<void>;
}

export class Jobs {
  private readonly jobs = new Map<string, JobInfo>();
  private readonly finishedListeners = new Set<(job: JobInfo, project: string | null) => void>();
  private counter = 0;

  constructor(
    private readonly toolsRoot: string | null,
    private readonly localDir: string,
    readonly launcher = new PythonLauncher({ toolsRoot, localDir })
  ) {}

  list(): JobInfo[] {
    return [...this.jobs.values()].sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1));
  }

  get(id: string): JobInfo | null {
    return this.jobs.get(id) ?? null;
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
    mkdirSync(join(this.localDir, 'jobs'), { recursive: true });
    const logPath = join(this.localDir, 'jobs', `${id}.log`);
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
        const { code, error } = await runStep(step);
        stepInfos[index].code = code;
        stepInfos[index].status = code === 0 ? 'done' : 'failed';
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
