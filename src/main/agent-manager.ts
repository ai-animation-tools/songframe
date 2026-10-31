/** Один менеджер владеет запуском, историей и завершением дерева процессов CLI. @link ../../README.md */
import { agentsTexts } from '@shared/texts/agents';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { AgentEvent, AgentJob, AgentSettings, AgentStartInput } from '@shared/agents';
import { agentTitle, type AgentProvider } from '@shared/agent-providers';
import { createAgentAdapter, type AgentAdapter, type AgentUpdate } from './agent-adapters';
import { AgentHistory } from './agent-history';
import { AgentError, JsonLines, providerDetail, providerFailure, redact } from './agent-protocol';
import { agentCommand, killProcessTree } from './agent-command';
import { agentEnvironment } from './agents';
import { readProjectAgentInstructions } from './checks';
import type { SettingsStore } from './settings';

interface Running {
  job: AgentJob;
  projectKey: string;
  child?: ChildProcessWithoutNullStreams;
  childClosed?: Promise<void>;
  timer?: NodeJS.Timeout;
  flush?: NodeJS.Timeout;
  ended: boolean;
  completed: boolean;
  outputBytes: number;
  /** Последнее нефатальное уведомление CLI: причина, если процесс завершится без результата. */
  lastNotice?: string;
}

interface Options {
  timeoutMs?: number;
  outputBytes?: number;
  adapter?: (provider: AgentProvider) => AgentAdapter;
}

const TEXT_LIMIT = 256 * 1024;
const LOG_LIMIT = 12000;
function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function validate(value: unknown): AgentStartInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError('INVALID_INPUT', agentsTexts.invalidInput);
  const input = value as Record<string, unknown>;
  for (const key of ['project', 'task', 'prompt']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].includes('\0')) throw new AgentError('INVALID_INPUT', agentsTexts.inputRequired);
  }
  if (
    !isAbsolute(input.project as string) ||
    (input.task as string).length > 120 ||
    Buffer.byteLength(input.prompt as string) > TEXT_LIMIT ||
    (input.context !== undefined && (typeof input.context !== 'string' || Buffer.byteLength(input.context) > TEXT_LIMIT)) ||
    (input.retryOf !== undefined && typeof input.retryOf !== 'string')
  )
    throw new AgentError('INVALID_INPUT', agentsTexts.invalidInputSize);
  return input as unknown as AgentStartInput;
}

export class AgentManager {
  private readonly jobs = new Map<string, AgentJob>();
  private readonly running = new Map<string, Running>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly history: AgentHistory;
  private stopping = false;
  private readonly completions = new Set<Promise<void>>();

  constructor(
    private readonly settings: SettingsStore,
    private readonly options: Options = {}
  ) {
    this.history = new AgentHistory(settings.localDir);
    for (const job of this.history.read()) {
      if (job.status === 'running') {
        job.status = 'interrupted';
        job.phase = agentsTexts.phase.restartInterrupted;
        job.finishedAt = new Date().toISOString();
        job.diagnostic = 'INTERRUPTED';
        job.message = agentsTexts.restartInterrupted;
        job.sequence++;
        this.history.write(job);
      }
      this.jobs.set(job.id, job);
    }
  }

  list(project?: string): AgentJob[] {
    return [...this.jobs.values()]
      .filter((job) => !project || job.project === project)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
      .map((job) => structuredClone(job));
  }
  get(id: string): AgentJob | null {
    const job = this.jobs.get(id);
    return job ? structuredClone(job) : null;
  }
  onEvent(listener: (event: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }
  start(value: unknown): AgentJob {
    return this.begin(value);
  }

  /** Только внутренний маршрут изображений: запись ограничена подготовленной рабочей папкой кандидатов.
   * Программу и модель задаёт провайдер изображений (SettingsStore.getImageAgent), а не выбранный текстовый агент. */
  startImages(value: AgentStartInput, workDir: string, config: AgentSettings): AgentJob {
    const directory = realpathSync(workDir);
    const base = realpathSync(join(this.settings.localDir, 'image-jobs'));
    if (!directory.startsWith(base + sep)) throw new AgentError('INVALID_INPUT', agentsTexts.invalidCandidateDirectory);
    return this.begin(value, directory, config);
  }

  private begin(value: unknown, imageDirectory?: string, imageConfig?: AgentSettings): AgentJob {
    if (this.stopping) throw new AgentError('INTERRUPTED', agentsTexts.applicationStopping);
    const input = validate(value);
    let project: string;
    try {
      project = realpathSync(input.project);
    } catch {
      throw new AgentError('INVALID_INPUT', agentsTexts.projectNotFound);
    }
    if (!existsSync(join(project, 'plan/project.json'))) throw new AgentError('INVALID_INPUT', agentsTexts.projectManifestMissing);
    // Резервируем проект до асинхронной диагностики: два клика не должны создать два запроса.
    if ([...this.running.values()].some((run) => run.projectKey === project)) throw new AgentError('PROJECT_BUSY', agentsTexts.projectBusy);
    // Пустая модель изображений оставляет выбор самой программе.
    const imageModel = imageConfig?.model?.trim();
    const config = imageConfig ? { provider: imageConfig.provider, ...(imageModel ? { model: imageModel } : {}) } : this.settings.getAgent();
    if (!config) throw new AgentError('INVALID_INPUT', agentsTexts.chooseAgentInSettings);
    if (input.retryOf) {
      const previous = this.jobs.get(input.retryOf);
      let previousProject: string | null = null;
      try {
        if (previous) previousProject = realpathSync(previous.project);
      } catch {
        /* Перемещённый проект нужно выбрать заново. */
      }
      if (!previous || previousProject !== project || previous.status === 'running') throw new AgentError('INVALID_INPUT', agentsTexts.retryUnavailable);
    }
    // Снимок привязан к проекту задания до асинхронной диагностики. Повтор читает актуальный текст заново;
    // исполнитель изображений независим от текстового агента и его постоянных инструкций.
    let instructions = '';
    if (!imageDirectory) {
      try {
        instructions = readProjectAgentInstructions(project);
      } catch (error) {
        throw new AgentError('INVALID_INPUT', error instanceof Error ? error.message : String(error));
      }
    }
    const job: AgentJob = {
      schemaVersion: 1,
      id: randomUUID(),
      sequence: 0,
      project: resolve(input.project),
      provider: config.provider,
      task: redact(input.task.trim()),
      ...(config.model ? { model: config.model } : {}),
      ...(input.retryOf ? { retryOf: input.retryOf } : {}),
      permissions: imageDirectory ? 'workspace-write' : 'read-only',
      inputHashes: { prompt: hash(input.prompt), context: hash(input.context ?? '') },
      status: 'running',
      phase: agentsTexts.phase.checking,
      startedAt: new Date().toISOString(),
      finishedAt: null,
      exitCode: null,
      result: '',
      log: ''
    };
    this.history.write(job);
    this.jobs.set(job.id, job);
    const run: Running = { job, projectKey: project, ended: false, completed: false, outputBytes: 0 };
    this.running.set(job.id, run);
    this.publish(run, 'started');
    const completion = this.launch(run, config, input, instructions, imageDirectory).then(() => run.childClosed);
    this.completions.add(completion);
    void completion.finally(() => this.completions.delete(completion));
    return structuredClone(job);
  }

  cancel(id: string): AgentJob {
    const run = this.running.get(id);
    if (run) this.finish(run, 'cancelled', new AgentError('CANCELLED', agentsTexts.cancelled));
    const job = this.get(id);
    if (!job) throw new AgentError('INVALID_INPUT', agentsTexts.jobNotFound);
    return job;
  }

  shutdown(): void {
    this.stopping = true;
    for (const run of [...this.running.values()]) this.finish(run, 'interrupted', new AgentError('INTERRUPTED', agentsTexts.shutdownInterrupted));
  }

  /** Временные рабочие папки можно удалять только после фактического закрытия CLI и его потоков. */
  async shutdownAndWait(): Promise<void> {
    this.shutdown();
    await Promise.all([...this.completions]);
  }

  private async launch(run: Running, config: AgentSettings, input: AgentStartInput, instructions: string, imageDirectory?: string): Promise<void> {
    try {
      const adapter = this.options.adapter?.(config.provider) ?? createAgentAdapter(config.provider);
      const check = await adapter.check(config);
      if (run.ended) return;
      if (check.availability !== 'available' || !check.executablePath)
        throw new AgentError(check.availability === 'not_found' ? 'CLI_NOT_FOUND' : 'CLI_UNAVAILABLE', check.message);
      if (!check.version) throw new AgentError('UNSUPPORTED_VERSION', agentsTexts.versionUnknown({ provider: agentTitle(config.provider) }));
      run.job.cliVersion = check.version;
      const args = adapter.args(config, check.version, imageDirectory ? 'write' : 'read');
      if (check.authorization !== 'authenticated')
        throw new AgentError(check.authorization === 'unauthenticated' ? 'AUTH_REQUIRED' : 'AUTH_UNKNOWN', check.message);
      run.job.phase = agentsTexts.phase.working;
      this.save(run);
      const parser = new JsonLines((event) => {
        for (const update of adapter.parse(event)) this.update(run, update);
      });
      const env = agentEnvironment();
      const command = await agentCommand(check.executablePath, args, env);
      if (run.ended) return;
      // В Linux отдельная группа позволяет завершить потомков CLI; в Windows дерево завершает taskkill.
      const child = spawn(command.file, command.args, {
        cwd: imageDirectory ?? run.job.project,
        env,
        shell: false,
        detached: process.platform !== 'win32',
        windowsHide: true,
        stdio: 'pipe'
      });
      run.child = child;
      run.childClosed = new Promise<void>((resolve) => child.once('close', () => resolve()));
      run.timer = setTimeout(() => this.finish(run, 'failed', new AgentError('TIMEOUT', agentsTexts.jobTimeout)), this.options.timeoutMs ?? 20 * 60 * 1000);
      const account = (chunk: Buffer): boolean => {
        if (run.ended) return false;
        run.outputBytes += chunk.length;
        if (run.outputBytes > (this.options.outputBytes ?? 8 * 1024 * 1024)) {
          this.finish(run, 'failed', new AgentError('OUTPUT_LIMIT', agentsTexts.jobOutputLimit));
          return false;
        }
        return true;
      };
      child.stdout.on('data', (chunk: Buffer) => {
        if (!account(chunk)) return;
        try {
          parser.push(chunk);
        } catch (error) {
          this.fail(run, error);
        }
      });
      // stderr не передаётся в историю: CLI может печатать ключи, промпт и содержимое файлов.
      let stderr = '';
      child.stderr.on('data', (chunk: Buffer) => {
        if (account(chunk)) stderr = (stderr + chunk.toString('utf8')).slice(-4096);
      });
      child.stdin.on('error', () => {
        /* Ранний выход CLI обрабатывается по close, без ошибки EPIPE в приложении. */
      });
      child.on('error', () =>
        this.finish(run, 'failed', new AgentError('CLI_UNAVAILABLE', agentsTexts.launchFailed({ provider: agentTitle(config.provider) })))
      );
      child.on('close', (code) => {
        if (run.ended) return;
        run.job.exitCode = code;
        try {
          parser.finish();
          if (run.ended) return;
          // stderr только классифицирует сбой и не показывается; причину даёт последнее уведомление агента.
          if (code !== 0) throw providerFailure(`${stderr} ${run.lastNotice ?? ''}`, run.lastNotice);
          if (!run.completed)
            throw run.lastNotice ? providerFailure(run.lastNotice, run.lastNotice) : new AgentError('PROTOCOL_ERROR', agentsTexts.completionMissing);
          this.finish(run, 'completed');
        } catch (error) {
          this.fail(run, error);
        }
      });
      /* eslint-disable no-restricted-syntax -- Инструкции запуска и заголовки ввода являются промптом агента, а не текстами интерфейса. */
      const prefix = imageDirectory
        ? 'Создай только запрошенные изображения в текущей рабочей папке кандидатов. Не изменяй материалы исходного проекта, не выполняй commit/push и не отправляй запросы сервисам генерации. Верни финальный JSON в запрошенном формате.'
        : 'Подготовь предложение для пользователя. Не изменяй файлы проекта, не выполняй commit/push, не удаляй исходники или assets и не отправляй платные запросы сервисам генерации. Правила хранения проекта описаны в его README.md.';
      const projectInstructions = instructions ? `\n\nПостоянные инструкции текстовому агенту этого проекта:\n${instructions}` : '';
      const prompt = `${prefix}${projectInstructions}\n\nЗадача:\n${input.prompt}${input.context ? `\n\nДополнительный контекст:\n${input.context}` : ''}`;
      /* eslint-enable no-restricted-syntax */
      child.stdin.end(prompt);
    } catch (error) {
      if (!run.ended) this.fail(run, error);
    }
  }

  private update(run: Running, update: AgentUpdate): void {
    if (run.ended) return;
    if (update.type === 'failed') throw update.error;
    if (update.type === 'notice') {
      const message = providerDetail(update.message);
      if (message) {
        run.lastNotice = message;
        // eslint-disable-next-line no-restricted-syntax -- Это запись журнала задания; её формат остаётся у менеджера.
        this.log(run, `Агент сообщил: ${message}`);
      }
    }
    if (update.type === 'session') run.job.sessionId = update.id;
    if (update.type === 'completed') {
      run.completed = true;
      if (update.result !== undefined) run.job.result = redact(update.result);
    }
    if (update.type === 'text_delta') {
      const text = redact(update.text);
      run.job.result += text;
      run.job.phase = agentsTexts.phase.receiving;
      this.limitResult(run);
      this.publish(run, 'text_delta', text);
    }
    if (update.type === 'tool_started' || update.type === 'tool_finished') {
      run.job.phase = update.type === 'tool_started' ? agentsTexts.phase.reading : agentsTexts.phase.working;
      // eslint-disable-next-line no-restricted-syntax -- Это сообщения журнала работы инструмента, а не подписи интерфейса.
      this.log(run, update.type === 'tool_started' ? 'Агент начал работу инструмента.' : 'Агент завершил работу инструмента.');
      this.publish(run, update.type, undefined, redact(update.tool));
    }
    this.limitResult(run);
    if (!run.flush)
      run.flush = setTimeout(() => {
        run.flush = undefined;
        try {
          this.save(run);
        } catch (error) {
          this.fail(run, error);
        }
      }, 250);
  }

  private limitResult(run: Running): void {
    if (Buffer.byteLength(run.job.result) > TEXT_LIMIT) {
      // Ограничиваем и ошибочную запись: слишком большой финальный ответ не раздувает историю.
      run.job.result = Buffer.from(run.job.result)
        .subarray(0, TEXT_LIMIT - 4)
        .toString('utf8');
      throw new AgentError('OUTPUT_LIMIT', agentsTexts.resultTooLarge);
    }
  }
  private save(run: Running): void {
    this.history.write(run.job);
  }
  private log(run: Running, text: string): void {
    run.job.log = (run.job.log + text + '\n').slice(-LOG_LIMIT);
  }
  private publish(run: Running, type: AgentEvent['type'], text?: string, tool?: string): void {
    run.job.sequence++;
    const event: AgentEvent = {
      jobId: run.job.id,
      project: run.job.project,
      sequence: run.job.sequence,
      phase: run.job.phase,
      type,
      ...(text !== undefined ? { text } : {}),
      ...(tool ? { tool } : {}),
      ...(['started', 'completed', 'failed'].includes(type) ? { job: structuredClone(run.job) } : {})
    };
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch {
        // eslint-disable-next-line no-restricted-syntax -- Это технический журнал доставки событий подписчику.
        console.warn('Не удалось доставить событие агента подписчику.');
      }
    }
  }
  private fail(run: Running, error: unknown): void {
    this.finish(run, 'failed', error instanceof AgentError ? error : new AgentError('CLI_ERROR', agentsTexts.jobSaveFailed));
  }
  private finish(run: Running, status: AgentJob['status'], error?: AgentError): void {
    if (run.ended) return;
    run.ended = true;
    clearTimeout(run.timer);
    clearTimeout(run.flush);
    // Уничтожается всё дерево, включая дочерние процессы CLI; чужие процессы не ищем по имени.
    if (run.child) killProcessTree(run.child);
    run.child?.stdin.destroy();
    run.child?.stdout.destroy();
    run.child?.stderr.destroy();
    run.job.status = status;
    run.job.finishedAt = new Date().toISOString();
    run.job.phase = agentsTexts.status[status];
    if (error) {
      run.job.diagnostic = error.code;
      run.job.message = error.detail;
    }
    // eslint-disable-next-line no-restricted-syntax -- Это итоговая запись журнала; Error.message сохраняет служебный код ошибки.
    this.log(run, error ? error.message : 'Задание завершено.');
    this.running.delete(run.job.id);
    this.publish(run, status === 'completed' ? 'completed' : 'failed');
    try {
      this.save(run);
    } catch {
      // eslint-disable-next-line no-restricted-syntax -- Это технический журнал сбоя записи истории.
      console.error('Не удалось сохранить итог задания агента. Проверьте каталог состояния.');
    }
  }
}
