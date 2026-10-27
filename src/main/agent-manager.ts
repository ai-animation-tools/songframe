/** Один менеджер владеет запуском, историей и завершением процессных групп Linux. @link ../../README.md */
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, realpathSync } from 'node:fs';
import { isAbsolute, join, resolve, sep } from 'node:path';
import type { AgentEvent, AgentJob, AgentSettings, AgentStartInput } from '@shared/agents';
import { createAgentAdapter, type AgentAdapter, type AgentUpdate } from './agent-adapters';
import { AgentHistory } from './agent-history';
import { AgentError, JsonLines, providerFailure, redact } from './agent-protocol';
import { agentEnvironment } from './agents';
import { readProjectSettings } from './checks';
import type { SettingsStore } from './settings';

interface Running {
  job: AgentJob;
  projectKey: string;
  child?: ChildProcessWithoutNullStreams;
  timer?: NodeJS.Timeout;
  flush?: NodeJS.Timeout;
  ended: boolean;
  completed: boolean;
  outputBytes: number;
}

interface Options {
  timeoutMs?: number;
  outputBytes?: number;
  adapter?: (provider: AgentSettings['provider']) => AgentAdapter;
}

const TEXT_LIMIT = 256 * 1024;
const LOG_LIMIT = 12000;
function hash(text: string): string {
  return createHash('sha256').update(text).digest('hex');
}

function validate(value: unknown): AgentStartInput {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new AgentError('INVALID_INPUT', 'Неверные параметры задания.');
  const input = value as Record<string, unknown>;
  for (const key of ['project', 'task', 'prompt']) {
    if (typeof input[key] !== 'string' || !input[key].trim() || input[key].includes('\0'))
      throw new AgentError('INVALID_INPUT', 'Укажите проект, задачу и промпт.');
  }
  if (
    !isAbsolute(input.project as string) ||
    (input.task as string).length > 120 ||
    Buffer.byteLength(input.prompt as string) > TEXT_LIMIT ||
    (input.context !== undefined && (typeof input.context !== 'string' || Buffer.byteLength(input.context) > TEXT_LIMIT)) ||
    (input.retryOf !== undefined && typeof input.retryOf !== 'string')
  )
    throw new AgentError('INVALID_INPUT', 'Неверный путь или слишком большой текст задания.');
  return input as unknown as AgentStartInput;
}

export class AgentManager {
  private readonly jobs = new Map<string, AgentJob>();
  private readonly running = new Map<string, Running>();
  private readonly listeners = new Set<(event: AgentEvent) => void>();
  private readonly history: AgentHistory;
  private stopping = false;

  constructor(
    private readonly settings: SettingsStore,
    private readonly options: Options = {}
  ) {
    this.history = new AgentHistory(settings.localDir);
    for (const job of this.history.read()) {
      if (job.status === 'running') {
        job.status = 'interrupted';
        job.phase = 'Прервано перезапуском';
        job.finishedAt = new Date().toISOString();
        job.diagnostic = 'INTERRUPTED';
        job.message = 'Приложение завершилось до получения результата. Автоматический повтор не выполнялся; для нового запуска подготовьте запрос заново.';
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

  /** Только внутренний маршрут опор: запись ограничена подготовленной рабочей папкой кандидатов. */
  startImages(value: AgentStartInput, workDir: string): AgentJob {
    const directory = realpathSync(workDir);
    const base = realpathSync(join(this.settings.localDir, 'image-jobs'));
    if (!directory.startsWith(base + sep)) throw new AgentError('INVALID_INPUT', 'Папка кандидатов не принадлежит заданиям изображений.');
    return this.begin(value, directory);
  }

  private begin(value: unknown, imageDirectory?: string): AgentJob {
    if (this.stopping) throw new AgentError('INTERRUPTED', 'Приложение завершает работу.');
    if (process.platform !== 'linux') throw new AgentError('CLI_UNAVAILABLE', 'Запуск агента сейчас поддерживается только на Linux.');
    const input = validate(value);
    let project: string;
    try {
      project = realpathSync(input.project);
    } catch {
      throw new AgentError('INVALID_INPUT', 'Папка проекта не найдена. Выберите её заново.');
    }
    if (!existsSync(join(project, 'plan/project.json'))) throw new AgentError('INVALID_INPUT', 'В папке нет plan/project.json.');
    // Резервируем проект до асинхронной диагностики: два клика не должны создать два запроса.
    if ([...this.running.values()].some((run) => run.projectKey === project))
      throw new AgentError('PROJECT_BUSY', 'Для этого проекта уже выполняется задание агента.');
    const globalConfig = imageDirectory ? this.settings.getImageAgent() : this.settings.getAgent();
    if (!globalConfig) throw new AgentError('INVALID_INPUT', 'Сначала выберите агента в настройках.');
    const imageSettings = imageDirectory ? readProjectSettings(project).generation?.image : null;
    const projectModel = imageSettings?.provider === 'codex' ? imageSettings.model?.trim() : undefined;
    // Пустая модель явного backend Codex оставляет выбор самому CLI; старый профиль и его путь не изменяем.
    // Глобальный model остаётся только для прежних прямых вызовов без image backend в проекте.
    const config = imageSettings?.provider === 'codex' ? { ...globalConfig, model: projectModel || undefined } : globalConfig;
    if (input.retryOf) {
      const previous = this.jobs.get(input.retryOf);
      let previousProject: string | null = null;
      try {
        if (previous) previousProject = realpathSync(previous.project);
      } catch {
        /* Перемещённый проект нужно выбрать заново. */
      }
      if (!previous || previousProject !== project || previous.status === 'running')
        throw new AgentError('INVALID_INPUT', 'Исходное задание для повтора недоступно.');
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
      phase: 'Проверка CLI',
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
    void this.launch(run, config, input, imageDirectory);
    return structuredClone(job);
  }

  cancel(id: string): AgentJob {
    const run = this.running.get(id);
    if (run) this.finish(run, 'cancelled', new AgentError('CANCELLED', 'Задание остановлено пользователем.'));
    const job = this.get(id);
    if (!job) throw new AgentError('INVALID_INPUT', 'Задание не найдено.');
    return job;
  }

  shutdown(): void {
    this.stopping = true;
    for (const run of [...this.running.values()])
      this.finish(run, 'interrupted', new AgentError('INTERRUPTED', 'Задание остановлено при закрытии приложения. Автоматический повтор не выполнялся.'));
  }

  private async launch(run: Running, config: AgentSettings, input: AgentStartInput, imageDirectory?: string): Promise<void> {
    try {
      const adapter = this.options.adapter?.(config.provider) ?? createAgentAdapter(config.provider);
      const check = await adapter.check(config);
      if (run.ended) return;
      if (check.availability !== 'available' || !check.executablePath)
        throw new AgentError(check.availability === 'not_found' ? 'CLI_NOT_FOUND' : 'CLI_UNAVAILABLE', check.message);
      if (!check.version) throw new AgentError('UNSUPPORTED_VERSION', 'Версия CLI не распознана. Проверьте выбранный файл в настройках.');
      run.job.cliVersion = check.version;
      const args = adapter.args(config, check.version);
      if (imageDirectory) {
        const sandbox = args.indexOf('--sandbox');
        if (config.provider !== 'codex' || sandbox < 0 || args[sandbox + 1] !== 'read-only')
          throw new AgentError('UNSUPPORTED_VERSION', 'CLI не поддерживает штатный режим создания кандидатов.');
        args[sandbox + 1] = 'workspace-write';
      }
      if (check.authorization !== 'authenticated')
        throw new AgentError(check.authorization === 'unauthenticated' ? 'AUTH_REQUIRED' : 'AUTH_UNKNOWN', check.message);
      run.job.phase = 'Агент выполняет задачу';
      this.save(run);
      const parser = new JsonLines((event) => {
        for (const update of adapter.parse(event)) this.update(run, update);
      });
      const child = spawn(check.executablePath, args, {
        cwd: imageDirectory ?? run.job.project,
        env: agentEnvironment(),
        shell: false,
        detached: true,
        stdio: 'pipe'
      });
      run.child = child;
      run.timer = setTimeout(
        () => this.finish(run, 'failed', new AgentError('TIMEOUT', 'Превышено время задания. Автоматический повтор не выполнялся.')),
        this.options.timeoutMs ?? 20 * 60 * 1000
      );
      const account = (chunk: Buffer): boolean => {
        if (run.ended) return false;
        run.outputBytes += chunk.length;
        if (run.outputBytes > (this.options.outputBytes ?? 8 * 1024 * 1024)) {
          this.finish(run, 'failed', new AgentError('OUTPUT_LIMIT', 'CLI превысил допустимый объём вывода.'));
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
      child.on('error', () => this.finish(run, 'failed', new AgentError('CLI_UNAVAILABLE', 'Не удалось запустить CLI. Проверьте путь и его зависимости.')));
      child.on('close', (code) => {
        if (run.ended) return;
        run.job.exitCode = code;
        try {
          parser.finish();
          if (run.ended) return;
          if (code !== 0) throw providerFailure(stderr);
          if (!run.completed) throw new AgentError('PROTOCOL_ERROR', 'CLI завершился без подтверждения результата.');
          this.finish(run, 'completed');
        } catch (error) {
          this.fail(run, error);
        }
      });
      const prefix = imageDirectory
        ? 'Создай только запрошенные изображения в текущей рабочей папке кандидатов. Не изменяй материалы исходного проекта, не выполняй commit/push и не отправляй запросы Kling. Верни финальный JSON со списком файлов.'
        : 'Подготовь предложение для пользователя. Не изменяй файлы проекта, не выполняй commit/push, не удаляй исходники или assets и не отправляй платные запросы Kling. Прочитай правила проекта AGENTS.md и README.md, если они есть.';
      const prompt = `${prefix}\n\nЗадача:\n${input.prompt}${input.context ? `\n\nДополнительный контекст:\n${input.context}` : ''}`;
      child.stdin.end(prompt);
    } catch (error) {
      if (!run.ended) this.fail(run, error);
    }
  }

  private update(run: Running, update: AgentUpdate): void {
    if (run.ended) return;
    if (update.type === 'failed') throw update.error;
    if (update.type === 'session') run.job.sessionId = update.id;
    if (update.type === 'completed') {
      run.completed = true;
      if (update.result !== undefined) run.job.result = redact(update.result);
    }
    if (update.type === 'text_delta') {
      const text = redact(update.text);
      run.job.result += text;
      run.job.phase = 'Получение ответа';
      this.limitResult(run);
      this.publish(run, 'text_delta', text);
    }
    if (update.type === 'tool_started' || update.type === 'tool_finished') {
      run.job.phase = update.type === 'tool_started' ? 'Чтение проекта' : 'Агент выполняет задачу';
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
      throw new AgentError('OUTPUT_LIMIT', 'Ответ агента слишком велик.');
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
        console.warn('Не удалось доставить событие агента подписчику.');
      }
    }
  }
  private fail(run: Running, error: unknown): void {
    this.finish(
      run,
      'failed',
      error instanceof AgentError ? error : new AgentError('CLI_ERROR', 'Не удалось обработать или сохранить задание агента. Проверьте каталог состояния.')
    );
  }
  private finish(run: Running, status: AgentJob['status'], error?: AgentError): void {
    if (run.ended) return;
    run.ended = true;
    clearTimeout(run.timer);
    clearTimeout(run.flush);
    // Уничтожается вся группа, включая дочерние процессы CLI; чужие процессы не ищем по имени.
    if (run.child?.pid) {
      try {
        process.kill(-run.child.pid, 'SIGKILL');
      } catch {
        /* Процесс мог уже завершиться. */
      }
    }
    run.child?.stdin.destroy();
    run.child?.stdout.destroy();
    run.child?.stderr.destroy();
    run.job.status = status;
    run.job.finishedAt = new Date().toISOString();
    run.job.phase = { completed: 'Завершено', failed: 'Ошибка', cancelled: 'Остановлено', interrupted: 'Прервано', running: 'Выполняется' }[status];
    if (error) {
      run.job.diagnostic = error.code;
      run.job.message = error.detail;
    }
    this.log(run, error ? error.message : 'Задание завершено.');
    this.running.delete(run.job.id);
    this.publish(run, status === 'completed' ? 'completed' : 'failed');
    try {
      this.save(run);
    } catch {
      console.error('Не удалось сохранить итог задания агента. Проверьте каталог состояния.');
    }
  }
}
