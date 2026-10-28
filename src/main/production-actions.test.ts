/** Границы оплаты и приёмки: настоящий Jobs, временные файлы и подставной launcher без сервисных вызовов. */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { JobInfo, ProductionQuote, ToolResult } from '@shared/types';
import { Jobs } from './jobs';
import { Production, readPackage, viewProduction } from './production';
import { PythonLauncher } from './python-launcher';

const requestSha = 'a'.repeat(64);
let project: string;
let packageDir: string;
let runner: Runner;
let jobs: Jobs;
let production: Production;
const ok = (): ToolResult => ({ code: 0, stdout: '{}', stderr: '', command: 'подставной инструмент' });
function write(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value));
}
function read<T = Record<string, unknown>>(path: string): T {
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
function patch(path: string, value: Record<string, unknown>): void {
  write(path, { ...read<Record<string, unknown>>(path), ...value });
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}
class Runner extends PythonLauncher {
  calls: { name: string; args: string[] }[] = [];
  prices: { verdict: string; estimate_credits: number | null; balance_credits: number | null }[] = [];
  hold: { name: string; action: string; promise: Promise<void> } | null = null;
  finalStatus = 'downloaded';
  missingDownload = false;
  override runtime(): ReturnType<PythonLauncher['runtime']> {
    return { command: 'не запускается', source: 'system-dev', argsPrefix: [], cwd: project, env: {}, version: 'тест' };
  }
  override async run(_project: string | null, name: string, args: string[]): Promise<ToolResult> {
    this.calls.push({ name, args });
    if (this.hold?.name === name && this.hold.action === args[0]) await this.hold.promise;
    const directory = args[args.indexOf('--dir') + 1];
    const workDir = args[args.indexOf('--work-dir') + 1];
    if (name === 'cost_check' && args[0] === 'check') {
      const price = this.prices.shift() ?? { verdict: 'ok', estimate_credits: 10, balance_credits: 100 };
      return { ...ok(), code: price.verdict === 'ok' ? 0 : 2, stdout: JSON.stringify(price) };
    }
    if (name === 'shot_workflow' && args[0] === 'decide') {
      const workflow = read<{ pending_decision?: { stage?: string }; stage: string }>(join(directory, 'workflow.json'));
      patch(join(directory, 'workflow.json'), {
        pending_decision: null,
        decision: { stage: workflow.pending_decision?.stage ?? workflow.stage, verdict: args[args.indexOf('--verdict') + 1] }
      });
    }
    if (name === 'shot_workflow' && args[0] === 'set-stage') patch(join(directory, 'workflow.json'), { stage: args.at(-1) });
    if (name === 'shot_workflow' && args[0] === 'ask') {
      const stage = args[args.indexOf('--stage') + 1];
      patch(join(directory, 'workflow.json'), {
        executor: 'app',
        pending_decision: { stage, executor: 'app', options: stage === 'request_choice' ? ['send', 'park', 'revise'] : ['accept', 'retry'] }
      });
    }
    if (name === 'shot_workflow' && args[0] === 'park') {
      const workflow = read<{ shot: string }>(join(directory, 'workflow.json'));
      patch(join(directory, 'workflow.json'), { stage: 'ready', wait_reason: 'user_saved' });
      const target = join(project, 'plan/awaiting', workflow.shot);
      mkdirSync(dirname(target), { recursive: true });
      renameSync(directory, target);
    }
    if (name === 'kling_request' && args[0] === 'submit') patch(join(workDir, 'attempt.json'), { status: 'submitted', generation_id: 'saved-id' });
    if (name === 'kling_request' && args[0] === 'resume')
      patch(join(workDir, 'attempt.json'), { status: 'submitted', generation_id: args[args.indexOf('--generation-id') + 1] });
    if (name === 'kling_request' && args[0] === 'watch') {
      if (this.finalStatus === 'downloaded' && !this.missingDownload) write(join(workDir, 'original.mp4'), 'paid-original');
      patch(join(workDir, 'attempt.json'), { status: this.finalStatus, downloads: this.finalStatus === 'downloaded' ? [{ path: 'original.mp4' }] : [] });
    }
    return ok();
  }
}
function fixture(name = 'M01-attempt-01', shot = 'M01'): string {
  const directory = join(project, 'plan/batches', name);
  write(join(directory, 'workflow.json'), {
    shot,
    stage: 'request_choice',
    executor: 'app',
    request_dir: 'request',
    pending_decision: { stage: 'request_choice', question: 'Отправить?', options: ['send', 'park', 'revise'], executor: 'app' }
  });
  write(join(directory, 'request/request.json'), {
    provider: 'kling',
    model: 'test-video',
    command: 'image_to_video',
    prompt: { path: 'prompt.txt' },
    parameters: { duration: 4 },
    inputs: [{ path: 'input.png' }]
  });
  write(join(directory, 'request/prompt.txt'), 'frozen prompt');
  write(join(directory, 'request/input.png'), 'frozen input');
  write(join(directory, 'request/attempt.json'), { status: 'prepared', request_sha256: requestSha, downloads: [] });
  return directory;
}
const view = (directory = packageDir) => readPackage(project, directory)!;
async function quote(directory = packageDir): Promise<ProductionQuote> {
  return production.quote(project, directory, requestSha, view(directory).decisionToken);
}
async function send(quoted: ProductionQuote, directory = packageDir, unknownCostConsentToken?: string): Promise<JobInfo> {
  return production.submit(project, directory, requestSha, view(directory).decisionToken, quoted.token, unknownCostConsentToken);
}
async function finished(job: JobInfo): Promise<JobInfo> {
  await vi.waitFor(() => expect(job.status).not.toBe('running'));
  return job;
}
const paidCalls = () => runner.calls.filter((call) => call.name === 'kling_request' && call.args[0] === 'submit');
function downloaded(): void {
  patch(join(packageDir, 'workflow.json'), { stage: 'downloaded', pending_decision: { stage: 'downloaded', options: ['accept', 'retry'], executor: 'app' } });
  patch(join(packageDir, 'request/attempt.json'), {
    status: 'downloaded',
    generation_id: 'saved-id',
    credits_consumed: 10,
    downloads: [{ path: 'original.mp4' }]
  });
  write(join(packageDir, 'request/original.mp4'), 'paid-original');
}

beforeEach(() => {
  project = mkdtempSync(join(tmpdir(), 'songframe-actions-'));
  vi.stubEnv('SONGFRAME_KLING_CLI', 'подставной CLI без запуска');
  write(join(project, 'plan/project.json'), { name: 'Проба', generation: { video: { provider: 'kling', provider_selected: true } } });
  write(join(project, 'plan/scenes.json'), {
    fps: 30,
    sequences: [{ id: 's', title: 'Сцена' }],
    scenes: [{ id: 'M01', sequence: 's', start_frame: 0, end_frame_exclusive: 60 }]
  });
  write(join(project, 'source/manifest.json'), { track: 'track.mp3' });
  write(join(project, 'source/track.mp3'), 'protected-source');
  packageDir = fixture();
  runner = new Runner({ toolsRoot: project });
  jobs = new Jobs(project, join(project, 'local'), runner);
  production = new Production(project, jobs);
});
afterEach(() => {
  vi.unstubAllEnvs();
  rmSync(project, { recursive: true, force: true });
});

describe('подтверждение платного запроса', () => {
  it('смена и удаление обложки сохраняют показанный токен и подтверждённую цену', async () => {
    const confirmed = await quote();
    const shown = view().decisionToken;
    const manifestPath = join(project, 'source/manifest.json');
    patch(manifestPath, { cover: { path: 'cover.png', sha256: 'b'.repeat(64) }, updated_at: '2026-01-01T00:00:00.000Z' });
    expect(view().decisionToken).toBe(shown);
    patch(manifestPath, { cover: null, updated_at: '2026-01-02T00:00:00.000Z' });
    expect(view().decisionToken).toBe(shown);
    await finished(await production.submit(project, packageDir, requestSha, shown, confirmed.token));
    expect(paidCalls()).toHaveLength(1);
  });
  it.each(['references', 'track', 'idea'])('изменение %s требует нового согласования запроса', async (field) => {
    const confirmed = await quote();
    const shown = view().decisionToken;
    patch(join(project, 'source/manifest.json'), { [field]: { changed: 'Изменён исходник' } });
    expect(view().decisionToken).not.toBe(shown);
    await expect(production.submit(project, packageDir, requestSha, shown, confirmed.token)).rejects.toThrow(/изменил/);
    expect(paidCalls()).toEqual([]);
  });
  it('quote → submit отправляет один раз; повторное использование и вызов без quote отклоняются', async () => {
    await expect(production.submit(project, packageDir, requestSha, view().decisionToken)).rejects.toThrow(/стоимость/);
    const confirmed = await quote();
    const job = await send(confirmed);
    await finished(job);
    expect(paidCalls()).toHaveLength(1);
    await expect(send(confirmed)).rejects.toThrow(/стоимость/);
    expect(paidCalls()).toHaveLength(1);
    expect(view().request?.attemptStatus).toBe('downloaded');
    expect(readFileSync(join(project, 'source/track.mp3'), 'utf8')).toBe('protected-source');
    expect(read(join(packageDir, 'request/attempt.json'))).toMatchObject({ generation_id: 'saved-id', request_sha256: requestSha });
  });

  it('park → перезапуск → fresh quote → send возобновляет тот же запрос без prepare и прежнего разрешения', async () => {
    const frozen = readFileSync(join(packageDir, 'request/request.json'), 'utf8');
    const oldQuote = await quote();
    await production.decide(project, packageDir, 'park', '', view().decisionToken);
    await production.park(project, packageDir);
    packageDir = join(project, 'plan/awaiting/M01');
    jobs = new Jobs(project, join(project, 'local-after-reload'), runner);
    production = new Production(project, jobs);
    expect(view().stage).toBe('ready');
    await expect(send(oldQuote)).rejects.toThrow(/стоимость/);
    const resumedQuote = await quote();
    expect(view().stage).toBe('ready');
    expect(paidCalls()).toEqual([]);
    const start = runner.calls.length;
    await finished(await send(resumedQuote));
    expect(paidCalls()).toHaveLength(1);
    const commands = runner.calls.slice(start).map((call) => `${call.name}:${call.args[0]}`);
    expect(commands.slice(0, 4)).toEqual(['cost_check:check', 'shot_workflow:set-stage', 'shot_workflow:ask', 'shot_workflow:decide']);
    const question = runner.calls.slice(start).find((call) => call.name === 'shot_workflow' && call.args[0] === 'ask')!;
    expect(question.args).toEqual(['ask', '--dir', packageDir, '--stage', 'request_choice', '--executor', 'app']);
    expect(runner.calls.some((call) => call.name === 'kling_request' && call.args[0] === 'prepare')).toBe(false);
    expect(readFileSync(join(packageDir, 'request/request.json'), 'utf8')).toBe(frozen);
    expect(view().request?.sha256).toBe(requestSha);
    expect(view().request?.attemptStatus).toBe('downloaded');
  });

  it('изменённая цена отложенного пакета не меняет его этап и не отправляет старый запрос', async () => {
    patch(join(packageDir, 'workflow.json'), { stage: 'ready', pending_decision: null });
    const confirmed = await quote();
    const start = runner.calls.length;
    runner.prices.push({ verdict: 'ok', estimate_credits: 11, balance_credits: 100 });
    await expect(send(confirmed)).rejects.toThrow(/Стоимость/);
    expect(view().stage).toBe('ready');
    expect(runner.calls.slice(start).map((call) => call.name)).toEqual(['cost_check']);
    expect(paidCalls()).toEqual([]);
  });

  it('quote другого пакета и прежняя цена после обновления quote не принимаются', async () => {
    const first = await quote();
    const other = fixture('M01-attempt-02');
    await expect(send(first, other)).rejects.toThrow(/стоимость/);
    const old = await quote();
    await quote();
    await expect(send(old)).rejects.toThrow(/стоимость/);
    expect(paidCalls()).toEqual([]);
  });

  it.each(['request/input.png', 'request/prompt.txt', 'description.md', 'workflow.json'])(
    'изменение показанного материала %s требует нового quote',
    async (file) => {
      const confirmed = await quote();
      const shown = view().decisionToken;
      if (file === 'workflow.json')
        patch(join(packageDir, file), { pending_decision: { stage: 'request_choice', question: 'Новый вопрос?', options: ['send'], executor: 'app' } });
      else write(join(packageDir, file), 'changed');
      await expect(production.submit(project, packageDir, requestSha, shown, confirmed.token)).rejects.toThrow(/изменил/);
      expect(paidCalls()).toEqual([]);
    }
  );

  it.each([
    { verdict: 'ok', estimate_credits: 11, balance_credits: 100 },
    { verdict: 'cost_or_balance_unknown', estimate_credits: null, balance_credits: 100 },
    { verdict: 'cost_or_balance_unknown', estimate_credits: 10, balance_credits: null },
    { verdict: 'insufficient_balance', estimate_credits: 10, balance_credits: 0 }
  ])('изменение стоимости или неподтверждённый остаток не отправляет: %j', async (price) => {
    const confirmed = await quote();
    runner.prices.push(price);
    await expect(send(confirmed)).rejects.toThrow(/Стоимость|остаток/);
    expect(paidCalls()).toEqual([]);
  });

  it.each([undefined, 'чужое-согласие'])('неизвестная цена без точного согласия %s блокирует отправку', async (consent) => {
    runner.prices.push({ verdict: 'cost_or_balance_unknown', estimate_credits: null, balance_credits: 100 });
    const confirmed = await quote();
    await expect(send(confirmed, packageDir, consent)).rejects.toThrow(/стоимость/);
    await expect(send(confirmed, packageDir, confirmed.token)).rejects.toThrow(/стоимость/);
    expect(paidCalls()).toEqual([]);
  });

  it.each([
    { verdict: 'cost_or_balance_unknown', estimate_credits: null, balance_credits: 100 },
    { verdict: 'cost_or_balance_unknown', estimate_credits: null, balance_credits: null },
    { verdict: 'ok', estimate_credits: 10, balance_credits: 100 }
  ])('точное согласие разрешает неизвестную цену после повторной проверки %j ровно один раз', async (fresh) => {
    runner.prices.push({ verdict: 'cost_or_balance_unknown', estimate_credits: null, balance_credits: 100 });
    const confirmed = await quote();
    runner.prices.push(fresh);
    await finished(await send(confirmed, packageDir, confirmed.token));
    await expect(send(confirmed, packageDir, confirmed.token)).rejects.toThrow(/стоимость/);
    expect(paidCalls()).toHaveLength(1);
  });

  it('согласие на старую оценку не переносится на новую с тем же SHA', async () => {
    runner.prices.push(
      { verdict: 'cost_or_balance_unknown', estimate_credits: null, balance_credits: 100 },
      { verdict: 'cost_or_balance_unknown', estimate_credits: null, balance_credits: 100 }
    );
    const old = await quote();
    const fresh = await quote();
    expect(fresh.requestSha).toBe(old.requestSha);
    await expect(send(old, packageDir, old.token)).rejects.toThrow(/стоимость/);
    await expect(send(fresh, packageDir, old.token)).rejects.toThrow(/стоимость/);
    expect(paidCalls()).toEqual([]);
  });

  it.each([
    { verdict: 'cost_or_balance_unknown', estimate_credits: 10, balance_credits: null },
    { verdict: 'ok', estimate_credits: 10, balance_credits: null },
    { verdict: 'insufficient_balance', estimate_credits: 10, balance_credits: 0 },
    { verdict: 'ok', estimate_credits: 10, balance_credits: 0 }
  ])('согласие не отменяет известную нехватку или неизвестный остаток при известной цене %j', async (price) => {
    runner.prices.push(price);
    const confirmed = await quote();
    await expect(send(confirmed, packageDir, confirmed.token)).rejects.toThrow(/стоимость/);
    expect(paidCalls()).toEqual([]);
  });

  it.each([
    { verdict: 'cost_or_balance_unknown', estimate_credits: 10, balance_credits: null },
    { verdict: 'insufficient_balance', estimate_credits: 10, balance_credits: 0 }
  ])('согласие на неизвестную цену не отменяет новую блокирующую оценку %j', async (price) => {
    runner.prices.push({ verdict: 'cost_or_balance_unknown', estimate_credits: null, balance_credits: 100 });
    const confirmed = await quote();
    runner.prices.push(price);
    await expect(send(confirmed, packageDir, confirmed.token)).rejects.toThrow(/Стоимость/);
    expect(paidCalls()).toEqual([]);
  });

  it('изменение материалов отменяет согласие на неизвестную цену', async () => {
    runner.prices.push({ verdict: 'cost_or_balance_unknown', estimate_credits: null, balance_credits: 100 });
    const confirmed = await quote();
    write(join(packageDir, 'request/prompt.txt'), 'другой промпт');
    await expect(send(confirmed, packageDir, confirmed.token)).rejects.toThrow(/изменил/);
    expect(paidCalls()).toEqual([]);
  });

  it.each(['секретный сырой ответ', 'null', '[]', '{"verdict":"чужой"}'])(
    'некорректная оценка %s допускает отдельное согласие без раскрытия ответа',
    async (stdout) => {
      vi.spyOn(runner, 'run').mockResolvedValueOnce({ code: 42, stdout, stderr: 'секретные параметры', command: 'скрытая команда' });
      const confirmed = await quote();
      expect(confirmed).toMatchObject({ verdict: 'cost_or_balance_unknown', credits: null, balance: null });
      expect(JSON.stringify(confirmed)).not.toContain('секрет');
      expect(jobs.list()).toEqual([]);
      await finished(await send(confirmed, packageDir, confirmed.token));
      expect(paidCalls()).toHaveLength(1);
    }
  );

  it('ошибка запуска оценки превращается в неизвестную цену без раскрытия исключения', async () => {
    vi.spyOn(runner, 'run').mockRejectedValueOnce(new Error('секретная команда'));
    const confirmed = await quote();
    expect(confirmed).toMatchObject({ verdict: 'cost_or_balance_unknown', credits: null });
    expect(JSON.stringify(confirmed)).not.toContain('секрет');
    await expect(send(confirmed)).rejects.toThrow(/стоимость/);
    expect(paidCalls()).toEqual([]);
  });

  it.each(['submitting', 'submission_unknown', 'submitted', 'running', 'downloaded', 'failed'])(
    'состояние %s не допускает новой отправки той же попытки',
    async (status) => {
      patch(join(packageDir, 'request/attempt.json'), { status });
      await expect(quote()).rejects.toThrow(/уже отправлялась/);
      expect(paidCalls()).toEqual([]);
    }
  );

  it.each([
    { executor: 'agent', pending_decision: null },
    { executor: 'app', pending_decision: { stage: 'request_choice', executor: 'agent', options: ['send'] } }
  ])('явный внешний исполнитель блокирует прямую отправку UI: %j', async (owner) => {
    patch(join(packageDir, 'workflow.json'), owner);
    await expect(quote()).rejects.toThrow(/внешний агент/);
    expect(runner.calls).toEqual([]);
  });

  it('legacy без executor и ожидающего вопроса сохраняет прямой маршрут SHA + quote', async () => {
    const workflow = read(join(packageDir, 'workflow.json'));
    delete workflow.executor;
    workflow.pending_decision = null;
    write(join(packageDir, 'workflow.json'), workflow);
    expect(view().executor).toBeUndefined();
    await finished(await send(await quote()));
    expect(paidCalls()).toHaveLength(1);
  });

  it('второй submit во время повторной проверки цены отклоняется до запуска задания', async () => {
    const confirmed = await quote();
    const gate = deferred();
    runner.hold = { name: 'cost_check', action: 'check', promise: gate.promise };
    const first = send(confirmed);
    await expect(send(confirmed)).rejects.toThrow(/уже выполняется/);
    gate.resolve();
    await finished(await first);
    expect(paidCalls()).toHaveLength(1);
  });
});

describe('согласования и исключение конфликтующих операций', () => {
  it.each(['approve', 'retry'])('ответ %s не отправляет генерацию и освобождает блокировку', async (verdict) => {
    const gate = deferred();
    runner.hold = { name: 'shot_workflow', action: 'decide', promise: gate.promise };
    const answer = production.decide(project, packageDir, verdict, '', view().decisionToken);
    await expect(production.decide(project, packageDir, 'revise', 'второй ответ', view().decisionToken)).rejects.toThrow(/уже выполняется/);
    expect(() => production.contactSheet(project, packageDir)).toThrow(/уже выполняется/);
    gate.resolve();
    await answer;
    expect(runner.calls.filter((call) => call.name === 'shot_workflow' && call.args[0] === 'decide')).toHaveLength(1);
    expect(production.isBusy(project, packageDir)).toBe(false);
    expect(paidCalls()).toEqual([]);
  });

  it('park блокирует параллельный decide и освобождает пакет после завершения', async () => {
    const gate = deferred();
    runner.hold = { name: 'shot_workflow', action: 'park', promise: gate.promise };
    const parked = production.park(project, packageDir);
    await expect(production.decide(project, packageDir, 'revise', '', view().decisionToken)).rejects.toThrow(/уже выполняется/);
    gate.resolve();
    await parked;
    expect(production.isBusy(project, packageDir)).toBe(false);
  });

  it('ошибка решения или park освобождает блокировку для исправленной операции', async () => {
    for (const action of ['decide', 'park']) {
      vi.spyOn(runner, 'run').mockResolvedValueOnce({ ...ok(), code: 1, stderr: 'Проверка остановлена' });
      const operation = action === 'decide' ? production.decide(project, packageDir, 'revise', '', view().decisionToken) : production.park(project, packageDir);
      await expect(operation).rejects.toThrow('Проверка остановлена');
      expect(production.isBusy(project, packageDir)).toBe(false);
    }
  });

  it('reopenQuestion снова задаёт вопрос о результате только пакету приложения без ожидающего вопроса', async () => {
    downloaded();
    await expect(production.reopenQuestion(project, packageDir)).rejects.toThrow(/уже задан/);
    await production.decide(project, packageDir, 'review', '', view().decisionToken);
    expect(view().pendingDecision).toBeNull();
    await production.reopenQuestion(project, packageDir);
    const ask = runner.calls.filter((item) => item.name === 'shot_workflow' && item.args[0] === 'ask').at(-1)!;
    expect(ask.args).toEqual(['ask', '--dir', packageDir, '--stage', 'downloaded', '--executor', 'app']);
    expect(view().pendingDecision?.stage).toBe('downloaded');
    expect(paidCalls()).toEqual([]);
  });

  it('discardAttempt удаляет пакет целиком, но не во время отправки и не при ссылке из черновика монтажа', async () => {
    patch(join(packageDir, 'request/attempt.json'), { status: 'submitted', generation_id: 'in-flight' });
    expect(() => production.discardAttempt(project, packageDir)).toThrow(/не завершена/);
    downloaded();
    write(join(project, 'plan/montage/draft.json'), {
      name: 'Проба стыков',
      clips: [{ path: `${relative(project, packageDir).replaceAll('\\', '/')}/request/original.mp4` }]
    });
    expect(() => production.discardAttempt(project, packageDir)).toThrow(/Проба стыков/);
    rmSync(join(project, 'plan/montage'), { recursive: true, force: true });
    production.discardAttempt(project, packageDir);
    expect(existsSync(packageDir)).toBe(false);
    expect(existsSync(join(project, 'source/track.mp3'))).toBe(true);
    expect(paidCalls()).toEqual([]);
  });

  it('план отмечается как ждущий действия по подготовленному запросу, вопросу, замечанию и результату', async () => {
    // fixture создаёт пакет на request_choice с открытым вопросом; без вопроса план всё равно ждёт отправки или отказа.
    expect(viewProduction(project, runner).shots[0].attention).toMatch(/Отправить\?/);
    patch(join(packageDir, 'workflow.json'), { pending_decision: null });
    expect(viewProduction(project, runner).shots[0].attention).toMatch(/запрос подготовлен/);
    patch(join(packageDir, 'workflow.json'), {
      pending_decision: { stage: 'request_choice', question: 'Отправить?', options: ['send', 'park', 'revise'], executor: 'app' }
    });
    await production.decide(project, packageDir, 'revise', 'камера ближе', view().decisionToken);
    expect(viewProduction(project, runner).shots[0].attention).toMatch(/доработка с агентом не запущена/);
    downloaded();
    expect(viewProduction(project, runner).shots[0].attention).toMatch(/вопрос ждёт ответа/);
    patch(join(packageDir, 'workflow.json'), { pending_decision: null, decision: null, executor: 'agent' });
    expect(viewProduction(project, runner).shots[0].attention).toBeNull();
  });

  it('повреждённая папка очереди видна в сводке и удаляется, а при незавершённой отправке остаётся', () => {
    const orphan = join(project, 'plan/awaiting/M01');
    mkdirSync(join(orphan, 'request/inputs'), { recursive: true });
    const before = viewProduction(project, runner);
    expect(before.broken).toEqual([{ dir: orphan, relative: 'plan/awaiting/M01', shot: 'M01', reason: expect.stringContaining('нет workflow.json') }]);
    expect(before.problems.join(' ')).toContain('plan/awaiting/M01');
    write(join(orphan, 'request/attempt.json'), { status: 'submitted', generation_id: 'paid' });
    expect(() => production.discardAttempt(project, orphan)).toThrow(/submitted/);
    rmSync(join(orphan, 'request/attempt.json'));
    production.discardAttempt(project, orphan);
    expect(existsSync(orphan)).toBe(false);
    expect(viewProduction(project, runner).broken).toEqual([]);
  });

  it('contactSheet сохраняет busy до завершения задания', async () => {
    const gate = deferred();
    runner.hold = { name: 'contact_sheet', action: '--package', promise: gate.promise };
    const job = production.contactSheet(project, packageDir);
    expect(() => production.contactSheet(project, packageDir)).toThrow(/уже выполняется/);
    await expect(production.park(project, packageDir)).rejects.toThrow(/уже выполняется/);
    gate.resolve();
    await finished(job);
    expect(production.isBusy(project, packageDir)).toBe(false);
  });
});

describe('явный провайдер сохранённого запроса', () => {
  it.each(['kling', 'Другой сервис', 'CustomProvider'])('readPackage показывает сохранённый provider %s', (provider) => {
    patch(join(packageDir, 'request/request.json'), { provider });
    expect(view().request?.provider).toBe(provider);
  });

  it.each([undefined, null, '', ' \n\t', 1])('readPackage отмечает некорректный provider %s', (provider) => {
    const frozen = read<Record<string, unknown>>(join(packageDir, 'request/request.json'));
    if (provider === undefined) delete frozen.provider;
    else frozen.provider = provider;
    write(join(packageDir, 'request/request.json'), frozen);
    expect(view().problems.join(' ')).toMatch(/провайдер/i);
  });

  it('viewProduction допускает совпавший generic provider и объясняет несовпадение', () => {
    // Просмотр сравнивает сохранённые значения сервиса независимо от каталога
    // поддерживаемых адаптеров: реальная отправка проверяется своим маршрутом.
    patch(join(packageDir, 'request/request.json'), { provider: 'CustomProvider' });
    patch(join(project, 'plan/project.json'), { generation: { video: { provider: 'customprovider', provider_selected: true } } });
    expect(viewProduction(project, runner).shots[0].regenerateProblem).toBeNull();
    patch(join(project, 'plan/project.json'), { generation: { video: { provider: 'other-provider', provider_selected: true } } });
    expect(viewProduction(project, runner).shots[0].regenerateProblem).toMatch(/CustomProvider.*other-provider/);
  });

  it('прямой regenerate готовит совпавший generic provider без платной отправки', async () => {
    patch(join(packageDir, 'request/request.json'), { provider: 'CustomProvider' });
    patch(join(project, 'plan/project.json'), { generation: { video: { provider: 'customprovider', provider_selected: true } } });
    const job = await finished(production.regenerate(project, 'M01'));
    expect(job.status).toBe('done');
    expect(runner.calls.filter((call) => call.name === 'regenerate_shot')).toHaveLength(1);
    expect(paidCalls()).toEqual([]);
  });

  it('прямой regenerate блокирует несовпавший generic provider до запуска инструмента', () => {
    patch(join(packageDir, 'request/request.json'), { provider: 'CustomProvider' });
    patch(join(project, 'plan/project.json'), { generation: { video: { provider: 'other-provider', provider_selected: true } } });
    expect(() => production.regenerate(project, 'M01')).toThrow(/CustomProvider.*other-provider/);
    expect(runner.calls).toEqual([]);
  });
});

describe('восстановление и подготовка повтора', () => {
  it('regenerate только готовит новый запрос и блокирует повторный запуск того же плана', async () => {
    const gate = deferred();
    runner.hold = { name: 'regenerate_shot', action: 'M01', promise: gate.promise };
    const job = production.regenerate(project, 'M01');
    expect(() => production.regenerate(project, 'M01')).toThrow(/уже подготавливается/);
    await expect(production.decide(project, packageDir, 'revise', '', view().decisionToken)).rejects.toThrow(/уже выполняется/);
    gate.resolve();
    await finished(job);
    const call = runner.calls.find((item) => item.name === 'regenerate_shot')!;
    expect(call.args).not.toContain('--submit');
    expect(paidCalls()).toEqual([]);
  });

  it.each(['submitting', 'submission_unknown'])('повтор при неясном исходе %s блокируется', (status) => {
    patch(join(packageDir, 'request/attempt.json'), { status });
    expect(() => production.regenerate(project, 'M01')).toThrow(/исход существующей отправки/);
    expect(runner.calls).toEqual([]);
  });

  it('resume использует сохранённый ID, запрещает замену и не содержит submit', async () => {
    patch(join(packageDir, 'request/attempt.json'), { status: 'submitted', generation_id: 'saved-id' });
    expect(() => production.resume(project, packageDir, 'other-id')).toThrow(/не заменяется/);
    const job = production.resume(project, packageDir);
    await finished(job);
    expect(paidCalls()).toEqual([]);
    expect(runner.calls.some((call) => call.name === 'kling_request' && call.args[0] === 'watch')).toBe(true);
    expect(view().stage).toBe('downloaded');
  });

  it('неизвестная отправка требует установленный ID и привязывает его без новой оплаты', async () => {
    patch(join(packageDir, 'request/attempt.json'), { status: 'submission_unknown' });
    expect(() => production.resume(project, packageDir)).toThrow(/установите ID/);
    await finished(production.resume(project, packageDir, 'restored-id'));
    expect(read(join(packageDir, 'request/attempt.json')).generation_id).toBe('restored-id');
    expect(paidCalls()).toEqual([]);
  });

  it.each(['failed', 'missing-download'])('успешный выход watch с %s не переводит пакет в downloaded и не задаёт вопрос приёмки', async (state) => {
    patch(join(packageDir, 'request/attempt.json'), { status: 'submitted', generation_id: 'saved-id' });
    runner.finalStatus = state === 'failed' ? 'failed' : 'downloaded';
    runner.missingDownload = state === 'missing-download';
    const job = await finished(production.resume(project, packageDir));
    expect(job.status).toBe('failed');
    expect(job.log).toContain('Результат не получен полностью');
    expect(view().stage).toBe('submitted');
    expect(runner.calls.some((call) => call.name === 'shot_workflow' && call.args[0] === 'ask')).toBe(false);
    expect(paidCalls()).toEqual([]);
  });
});

describe('принятие именно просмотренного результата', () => {
  it('решение accept не меняет resultToken; корректный участок 1..3 секунды передаётся как 30:90 кадров', async () => {
    downloaded();
    const shown = view();
    await production.decide(project, packageDir, 'accept', '', shown.decisionToken);
    expect(view().resultToken).toBe(shown.resultToken);
    const gate = deferred();
    runner.hold = { name: 'accept_shot', action: 'M01', promise: gate.promise };
    const job = production.accept(project, 'M01', packageDir, { mode: 'cut', cutStart: 1, cutEnd: 3, holdLast: 12, expectedResultToken: shown.resultToken });
    expect(() => production.accept(project, 'M01', packageDir, { mode: 'full', expectedResultToken: shown.resultToken })).toThrow(/уже выполняется/);
    gate.resolve();
    await finished(job);
    const call = runner.calls.find((item) => item.name === 'accept_shot')!;
    expect(call.args).toEqual(['M01', '--package', packageDir, '--cut', '30:90', '--hold-last', '12', '--clean']);
    expect(paidCalls()).toEqual([]);
    expect(read(join(packageDir, 'request/attempt.json'))).toMatchObject({ generation_id: 'saved-id', credits_consumed: 10 });
    expect(readFileSync(join(project, 'source/track.mp3'), 'utf8')).toBe('protected-source');
  });

  it('приёмка сцены с принятым комплектом требует replaceExisting и передаёт --replace', async () => {
    downloaded();
    write(join(project, 'assets/shots/M01/manifest.json'), { schema_version: 1, shot: 'M01' });
    const shown = view();
    expect(() => production.accept(project, 'M01', packageDir, { mode: 'full', expectedResultToken: shown.resultToken })).toThrow(/уже есть принятый комплект/);
    const job = production.accept(project, 'M01', packageDir, { mode: 'full', replaceExisting: true, expectedResultToken: shown.resultToken });
    await finished(job);
    const call = runner.calls.find((item) => item.name === 'accept_shot')!;
    expect(call.args).toEqual(['M01', '--package', packageDir, '--full', '--replace', '--clean']);
    expect(job.steps[0].label).toBe('замена комплекта в assets');
  });

  it.each(['original', 'attempt', 'request'])('замена %s инвалидирует токены и блокирует stale accept до Jobs', (part) => {
    downloaded();
    const shown = view();
    if (part === 'original') {
      const path = join(packageDir, 'request/original.mp4');
      const before = statSync(path);
      writeFileSync(path, 'other-orignal');
      utimesSync(path, before.atime, before.mtime);
    } else if (part === 'attempt') patch(join(packageDir, 'request/attempt.json'), { credits_consumed: 42 });
    else patch(join(packageDir, 'request/request.json'), { model: 'another-model' });
    expect(view().resultToken).not.toBe(shown.resultToken);
    expect(view().decisionToken).not.toBe(shown.decisionToken);
    expect(() => production.accept(project, 'M01', packageDir, { mode: 'full', expectedResultToken: shown.resultToken })).toThrow(/Результат изменился/);
    expect(jobs.list()).toEqual([]);
  });

  it.each([
    [0.01, 1],
    [Number.NaN, 3],
    [1, Number.POSITIVE_INFINITY],
    [-1, 3],
    [3, 1]
  ])('неточный или неправильный участок %j..%j отклоняется до запуска', (cutStart, cutEnd) => {
    downloaded();
    expect(() => production.accept(project, 'M01', packageDir, { mode: 'cut', cutStart, cutEnd, expectedResultToken: view().resultToken })).toThrow(
      /Границы участка|Конец участка/
    );
    expect(jobs.list()).toEqual([]);
  });
});
