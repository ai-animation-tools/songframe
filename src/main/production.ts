/**
 * Производство сцен в главном процессе: состояние планов по файлам проекта, пакеты с опорами и промптом,
 * решения пользователя (через shot_workflow decide) и длинные задания (отправка, повтор, приёмка).
 */

import { FPS } from '@shared/video';
import { canAgreeToUnknownCost, priceAllowsGeneration } from '@shared/generation-consent';
import { ATTEMPT_LABELS, SCENE_CHANGED } from '@shared/production-labels';
import { createHash, randomUUID } from 'node:crypto';
import { closeSync, existsSync, mkdirSync, openSync, readSync, readdirSync, readFileSync, statSync, realpathSync, lstatSync, rmSync } from 'node:fs';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';
import type {
  AcceptOptions,
  BrokenPackage,
  BundleInfo,
  ExportBundleOptions,
  JobInfo,
  KeyframeNoteScope,
  PackageKeyframe,
  PackageView,
  ProductionView,
  ProductionQuote,
  ScenesFile,
  ShotProduction
} from '@shared/types';
import { PythonLauncher } from './python-launcher';
import { paidAdapters } from './providers';
import type { Jobs } from './jobs';
import { runTool } from './tools';
import type { PaidMediaProvider, PreparedMediaRequest } from './media-providers';
import type { MediaKind, MediaModelSelection } from '@shared/media-providers';
import { isPaidMediaProvider, normalizeMediaProvider, sameMediaProvider } from '@shared/media-providers';
import { sourceInputDigest } from './source-input-hash';
import { checkedBuiltOutput } from './built-output-path';
import { readProjectSettings } from './checks';
import { readPackageSpeech } from './speech';
import { derivedShotSource } from './derived-shot';
import { currentShotFingerprint, restampPackage, shotAcceptance } from './shot-acceptance';
import { derivedShotReason } from '@shared/production-workflow';

const STAGE_LABELS: Record<string, string> = {
  description_review: 'описание на согласовании',
  keyframes_review: 'опоры на согласовании',
  prompt_review: 'видеопромпт на согласовании',
  request_choice: 'запрос на подтверждении',
  image_request_choice: 'запрос изображения на подтверждении',
  image_submitted: 'изображение отправлено, ждём результат',
  image_downloaded: 'изображение получено, выберите вариант опоры',
  ready: 'отложено в очередь',
  needs_revision: 'требует исправления',
  submitted: 'отправлено, ждём результат',
  downloaded: 'результат получен, ждёт просмотра',
  edit_review: 'генерация принята, участок не выбран',
  accepted: 'принята, перенос в assets не завершён'
};
function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, 'utf-8')) as T;
  } catch {
    return null;
  }
}

/** Утрата файла не отменяет приёмку, но путь для проигрывателя должен вести к существующему видео. */
function existingAssetFile(assetDir: string, path: string | undefined): string | null {
  if (!path) return null;
  const fullPath = join(assetDir, path);
  try {
    return statSync(fullPath).isFile() ? fullPath : null;
  } catch {
    return null;
  }
}

interface Workflow {
  shot: string;
  stage: string;
  mode?: string | null;
  wait_reason?: string | null;
  request_dir?: string | null;
  image_request_dir?: string | null;
  image_frame_id?: string | null;
  image_requests?: { request_dir: string; frame_id: string; request_sha256: string; provider: string }[];
  retry_of?: string | null;
  batch?: string | null;
  scene_sha256?: string | null;
  timing?: PackageView['timing'];
  keyframes?: { id: string; role: 'first' | 'middle' | 'last'; time_seconds: number; note?: string | null; path?: string | null; approved?: boolean }[];
  prompt?: { path?: string; approved?: boolean };
  pending_decision?: PackageView['pendingDecision'];
  decision?: PackageView['decision'];
  keyframe_notes?: PackageView['keyframeNotes'];
}

export { SCENE_CHANGED };

export function readPackage(project: string, dir: string): PackageView | null {
  const workflow = readJson<Workflow>(join(dir, 'workflow.json'));
  if (!workflow || typeof workflow.shot !== 'string') return null;
  const problems: string[] = [];
  const keyframes: PackageKeyframe[] = (workflow.keyframes ?? []).map((k) => ({
    id: k.id,
    role: k.role,
    time_seconds: k.time_seconds,
    note: k.note,
    imagePath: k.path && existsSync(join(dir, k.path)) ? join(dir, k.path) : null,
    approved: !!k.approved
  }));
  const promptPath = join(dir, workflow.prompt?.path ?? 'video-prompt.txt');
  const prompt = existsSync(promptPath) ? { path: promptPath, approved: !!workflow.prompt?.approved, text: readFileSync(promptPath, 'utf-8') } : null;
  let request: PackageView['request'] = null;
  const imageRequest = workflow.stage.startsWith('image_');
  const activeRequest = imageRequest ? workflow.image_request_dir : workflow.request_dir;
  if (activeRequest) {
    const requestDir = join(dir, activeRequest);
    const frozen = readJson<{
      provider: string;
      kind?: 'image' | 'video';
      command?: string;
      model: string;
      model_selection?: MediaModelSelection;
      prompt?: string | { path?: string };
      parameters: Record<string, unknown>;
      inputs: { slot?: string; role?: string; path: string }[];
    }>(join(requestDir, 'request.json'));
    const attempt = readJson<{
      request_sha256?: string;
      status?: string;
      generation_id?: string;
      manual_result?: boolean;
      credits_consumed?: number;
      downloads?: { path?: string }[];
    }>(join(requestDir, 'attempt.json'));
    if (frozen) {
      if (typeof frozen.provider !== 'string' || !frozen.provider.trim()) problems.push('В сохранённом запросе не указан провайдер.');
      if (imageRequest && frozen.kind !== 'image') problems.push('Активный запрос опоры должен иметь kind=image.');
      if (!imageRequest && frozen.kind === 'image') problems.push('Видео-запрос не может ссылаться на попытку изображения.');
      if (
        imageRequest &&
        !(workflow.image_requests ?? []).some(
          (entry) => entry.request_dir === activeRequest && entry.frame_id === workflow.image_frame_id && entry.request_sha256 === attempt?.request_sha256
        )
      )
        problems.push('Активный запрос изображения не совпадает с историей пакета.');
      // В подтверждении показываем замороженный промпт запроса, а не редактируемый текст пакета.
      const frozenPromptPath = join(requestDir, typeof frozen.prompt === 'string' ? frozen.prompt : (frozen.prompt?.path ?? 'prompt.txt'));
      const downloads = [
        ...(attempt?.downloads ?? [])
          .map((d) => d.path)
          .filter((p): p is string => !!p)
          .map((p) => join(requestDir, p)),
        ...(existsSync(requestDir)
          ? readdirSync(requestDir)
              .filter((n) => /^original(-\d+)?\.(mp4|png|jpg|webp)$/.test(n))
              .map((n) => join(requestDir, n))
          : [])
      ];
      request = {
        dir: requestDir,
        kind: frozen.kind ?? 'video',
        provider: typeof frozen.provider === 'string' ? frozen.provider.trim() : undefined,
        command: frozen.command,
        ...(imageRequest && workflow.image_frame_id ? { frameId: workflow.image_frame_id } : {}),
        sha256: attempt?.request_sha256 ?? null,
        model: frozen.model,
        ...(frozen.model_selection ? { modelSelection: frozen.model_selection } : {}),
        promptText: existsSync(frozenPromptPath) ? readFileSync(frozenPromptPath, 'utf8') : null,
        parameters: frozen.parameters ?? {},
        inputs: (frozen.inputs ?? []).map((i) => ({ slot: i.slot, role: i.role, path: i.path, imagePath: join(requestDir, i.path) })),
        attemptStatus: attempt?.status ?? null,
        generationId: attempt?.generation_id ?? null,
        manualResult: attempt?.manual_result === true,
        creditsConsumed: typeof attempt?.credits_consumed === 'number' ? attempt.credits_consumed : null,
        downloads: [...new Set(downloads)].filter((p) => existsSync(p))
      };
    } else problems.push('В папке запроса нет request.json.');
  }
  const descriptionPath = join(dir, 'description.md');
  const description = existsSync(descriptionPath) ? readFileSync(descriptionPath, 'utf-8') : null;
  const previewDir = join(dir, 'preview');
  const preview = existsSync(previewDir)
    ? readdirSync(previewDir)
        .filter((n) => /\.(png|jpg|webp)$/i.test(n))
        .map((n) => join(previewDir, n))
    : [];
  const stageLabel =
    workflow.stage === 'submitted' && request?.attemptStatus
      ? `${STAGE_LABELS[workflow.stage]}: ${ATTEMPT_LABELS[request.attemptStatus] ?? request.attemptStatus}`
      : (STAGE_LABELS[workflow.stage] ?? workflow.stage);
  let decisionToken: string | undefined;
  let resultToken: string | undefined;
  try {
    if (request?.downloads.length) resultToken = packageResultToken(request.dir, request.downloads);
    decisionToken = packageToken(project, dir, workflow, resultToken);
  } catch (error) {
    problems.push(error instanceof Error ? error.message : String(error));
  }
  // Пакет подготовлен по отпечатку постановки: после её правки отправка и согласования ждут решения пользователя.
  const currentScene = workflow.stage === 'accepted' ? null : currentShotFingerprint(project, workflow.shot);
  const sceneChanged = !!currentScene && workflow.scene_sha256 !== currentScene;
  if (sceneChanged) problems.push(SCENE_CHANGED);
  return {
    dir,
    decisionToken,
    resultToken,
    relative: relative(project, dir),
    shot: workflow.shot,
    stage: workflow.stage,
    stageLabel,
    waitReason: workflow.wait_reason ?? null,
    mode: workflow.mode ?? null,
    retryOf: workflow.retry_of ?? null,
    batch: workflow.batch ?? null,
    timing: workflow.timing ?? null,
    keyframes,
    description,
    prompt,
    request,
    speech: readPackageSpeech(dir),
    pendingDecision: workflow.pending_decision ?? null,
    decision: workflow.decision ?? null,
    keyframeNotes: workflow.keyframe_notes ?? [],
    sceneChanged,
    preview,
    problems
  };
}

const tokenDigests = new Map<string, { identity: string; hash: string }>();
function tokenDigest(file: string): string {
  const info = statSync(file, { bigint: true });
  const identity = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`;
  const cached = tokenDigests.get(file);
  if (cached?.identity === identity) return cached.hash;
  // Платные MP4 хешируются блоками только после изменения stat identity, без копии всего видео в памяти.
  const digest = createHash('sha256');
  const descriptor = openSync(file, 'r');
  try {
    const buffer = Buffer.allocUnsafe(1024 * 1024);
    let count: number;
    while ((count = readSync(descriptor, buffer, 0, buffer.length, null)) > 0) digest.update(buffer.subarray(0, count));
  } finally {
    closeSync(descriptor);
  }
  const hash = digest.digest('hex');
  if (tokenDigests.size >= 4096) tokenDigests.clear();
  tokenDigests.set(file, { identity, hash });
  return hash;
}

/** Ответ связан с показанными байтами вопроса, кандидатов и замороженного запроса. */
function packageToken(project: string, directory: string, workflow: Workflow, resultToken?: string): string {
  const hash = createHash('sha256');
  const paths = new Set(['workflow.json', 'description.md', workflow.prompt?.path ?? 'video-prompt.txt']);
  for (const frame of workflow.keyframes ?? []) if (frame.path) paths.add(frame.path);
  const requestDirectories = new Set([workflow.request_dir, workflow.image_request_dir, ...(workflow.image_requests ?? []).map((entry) => entry.request_dir)]);
  for (const requestDir of requestDirectories) {
    if (!requestDir) continue;
    paths.add(join(requestDir, 'request.json'));
    const request = readJson<{ prompt?: string | { path?: string }; inputs?: { path: string }[] }>(join(directory, requestDir, 'request.json'));
    if (request) {
      paths.add(join(requestDir, typeof request.prompt === 'string' ? request.prompt : (request.prompt?.path ?? 'prompt.txt')));
      for (const input of request.inputs ?? []) paths.add(join(requestDir, input.path));
    }
  }
  for (const path of [...paths].sort()) {
    const file = resolve(directory, path);
    if (!file.startsWith(resolve(directory) + '/')) throw new Error('Материалы пакета ссылаются за пределы своей папки.');
    hash
      .update(path)
      .update('\0')
      .update(existsSync(file) && lstatSync(file).isFile() ? tokenDigest(file) : '<нет файла>')
      .update('\0');
  }
  for (const path of ['plan/scenes.json', 'plan/cast.json', 'plan/project.json', 'source/manifest.json']) {
    const file = join(project, path);
    hash
      .update(path)
      .update('\0')
      // Декоративная обложка не меняет показанное согласование или замороженный платный запрос.
      .update(path === 'source/manifest.json' ? (sourceInputDigest(project) ?? '<нет файла>') : existsSync(file) ? tokenDigest(file) : '<нет файла>')
      .update('\0');
  }
  if (['downloaded', 'edit_review', 'image_downloaded'].includes(workflow.stage)) hash.update('result').update(resultToken ?? '<нет результата>');
  return hash.digest('hex');
}

/** Принятие связано с полученными байтами и метаданными сервиса, но не с последующим ответом workflow. */
function packageResultToken(requestDir: string, downloads: string[]): string {
  const hash = createHash('sha256');
  const paths = new Set([join(requestDir, 'request.json'), join(requestDir, 'attempt.json'), ...downloads]);
  for (const path of [...paths].sort()) {
    const file = resolve(path);
    if (!file.startsWith(resolve(requestDir) + '/') || !lstatSync(file).isFile()) throw new Error('Результат должен быть обычным файлом в папке запроса.');
    hash.update(relative(requestDir, file)).update('\0').update(tokenDigest(file)).update('\0');
  }
  return hash.digest('hex');
}

function checkedPackage(project: string, packageDir: string): string {
  const directory = resolve(project, packageDir);
  const local = relative(realpathSync(project), realpathSync(directory));
  if (!/^plan\/(batches|awaiting)\/[^/]+$/.test(local) || lstatSync(directory).isSymbolicLink())
    throw new Error('Выберите обычную папку рабочего пакета в plan/batches или plan/awaiting.');
  return realpathSync(directory);
}

/** Что ждёт от пользователя пакет: вопрос, замечание без доработки, отправка или просмотр результата. */
function packageAttention(pkg: PackageView): string | null {
  const name = basename(pkg.dir);
  if (pkg.pendingDecision) return `${name}: ${pkg.pendingDecision.question || 'вопрос ждёт ответа'}`;
  if (pkg.decision?.verdict === 'revise' && pkg.stage !== 'accepted') return `${name}: замечание записано, доработка с агентом не запущена`;
  const status = pkg.request?.attemptStatus ?? '';
  if (['request_choice', 'image_request_choice', 'ready'].includes(pkg.stage) && status === 'prepared')
    return `${name}: запрос подготовлен, ждёт отправки, очереди или отказа`;
  if (['submission_unknown', 'submitting'].includes(status)) return `${name}: исход отправки неизвестен: проверьте историю генераций сервиса`;
  if (['downloaded', 'edit_review'].includes(pkg.stage) && status === 'downloaded') return `${name}: результат получен, ждёт просмотра`;
  if (pkg.stage === 'image_downloaded') return `${name}: изображение получено, выберите опору`;
  return null;
}

/** Повтор выбирает источник как regenerate_shot --source auto; @link ../../tools/regenerate_shot/README.md. */
function regenerateProblem(project: string, shot: string, packages: PackageView[], selectedProvider: string): string | null {
  if (!selectedProvider) return `${shot}: сначала выберите провайдера видео в настройках проекта.`;
  const compareProvider = (value: unknown): string | null => {
    const provider = typeof value === 'string' ? value.trim() : '';
    if (!provider) return `${shot}: провайдер сцены не указан. Подготовьте новый пакет.`;
    if (!sameMediaProvider(provider, selectedProvider)) {
      return `${shot}: провайдер сцены — ${provider}, текущий выбранный — ${selectedProvider}. Для подготовки повтора провайдеры должны совпадать.`;
    }
    return null;
  };
  const requests: { modified: number; path: string; provider: string | undefined }[] = [];
  for (const pkg of packages) {
    const workflow = readJson<Workflow>(join(pkg.dir, 'workflow.json'));
    if (typeof workflow?.request_dir !== 'string' || !workflow.request_dir) continue;
    try {
      // Берём провайдера фактического источника повтора и сравниваем с текущим выбором проекта.
      // Как и инструмент, выбираем последний request.json; порядок workflow.json может отличаться.
      const path = resolve(pkg.dir, workflow.request_dir, 'request.json');
      const stat = statSync(path);
      if (stat.isFile()) {
        const request = readJson<{ provider?: unknown }>(path);
        requests.push({ modified: stat.mtimeMs, path, provider: typeof request?.provider === 'string' ? request.provider : undefined });
      }
    } catch {
      // Пакет без подготовленного запроса не участвует в выборе source=auto.
    }
  }
  requests.sort((a, b) => a.modified - b.modified || (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  if (requests.length) return compareProvider(requests[requests.length - 1].provider);
  const snapshotPath = join(project, 'assets', 'shots', shot, 'generation-request.json');
  if (!existsSync(snapshotPath)) return `${shot}: нет сохранённого запроса для повтора. Подготовьте новый пакет.`;
  const snapshot = readJson<{ provider?: unknown }>(snapshotPath);
  if (!snapshot || typeof snapshot !== 'object') return `${shot}: не удалось прочитать снимок сохранённого запроса.`;
  return compareProvider(snapshot.provider);
}

export function viewProduction(project: string, launcher = new PythonLauncher({ toolsRoot: null })): ProductionView {
  const problems: string[] = [];
  // Наличие инструментов относится к приложению и не зависит от готовности сценария проекта.
  const tools = {
    python: launcher.available(),
    providers: Object.fromEntries(paidAdapters().map((adapter) => [adapter.id, adapter.installed(launcher.options)]))
  };
  const scenes = readJson<ScenesFile>(join(project, 'plan', 'scenes.json'));
  if (!scenes) return { shots: [], broken: [], problems: ['Сначала нужен сценарий. Создайте его на странице «Сценарий».'], tools };
  const packages: PackageView[] = [];
  const broken: BrokenPackage[] = [];
  for (const base of ['plan/batches', 'plan/awaiting']) {
    const folder = join(project, base);
    if (!existsSync(folder)) continue;
    for (const entry of readdirSync(folder, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const view = readPackage(project, join(folder, entry.name));
      if (view) packages.push(view);
      else {
        const dir = join(folder, entry.name);
        const shotMatch = /^(M\d{2}(?:\.\d+)?)(?:[-_]|$)/.exec(entry.name);
        // Очередь состоит только из пакетов; в batches недописанной считается лишь папка попытки плана без workflow.json.
        const packageLike = base === 'plan/awaiting' || (!!shotMatch && !existsSync(join(dir, 'montage.json')) && !existsSync(join(dir, 'review.json')));
        if (packageLike && !existsSync(join(dir, 'workflow.json')))
          broken.push({
            dir,
            relative: `${base}/${entry.name}`,
            shot: shotMatch?.[1] ?? null,
            reason: 'нет workflow.json: папка осталась после прерванной операции'
          });
      }
    }
  }
  packages.sort((a, b) => statSync(join(b.dir, 'workflow.json')).mtimeMs - statSync(join(a.dir, 'workflow.json')).mtimeMs);
  const titles = new Map(scenes.sequences.map((s) => [s.id, s.title]));
  const videoGeneration = scenes.scenes.length ? readProjectSettings(project).generation?.video : null;
  const selectedProvider = videoGeneration?.provider_selected === true && typeof videoGeneration.provider === 'string' ? videoGeneration.provider.trim() : '';
  const fps = Number(scenes.fps) || FPS;
  const acceptance = shotAcceptance(project, scenes);
  if (acceptance.problem) problems.push(acceptance.problem);
  const shots: ShotProduction[] = scenes.scenes.map((scene) => {
    const assetDir = join(project, 'assets', 'shots', scene.id);
    const manifest = readJson<{ accepted_edit?: { video?: { path?: string } }; generation?: { original?: { path?: string } } }>(
      join(assetDir, 'manifest.json')
    );
    const video = existingAssetFile(assetDir, manifest?.accepted_edit?.video?.path);
    const mine = packages.filter((p) => p.shot === scene.id);
    // completed обозначает художественную приёмку по текущей постановке; наличие готового файла показывается отдельно.
    const accepted = manifest ? (acceptance.accepted.get(scene.id) ?? 'stale') : null;
    let state: ShotProduction['state'] = accepted ?? (mine.length ? 'progress' : 'planned');
    let stageLabel =
      accepted === 'stale'
        ? 'принят по прежней постановке: нужно новое производство'
        : manifest
          ? video
            ? 'принят, монтажное видео сохранено'
            : 'принят, файл монтажного видео отсутствует'
          : (mine[0]?.stageLabel ?? 'постановка есть, работа не начата');
    const waiting = mine.find((p) => p.pendingDecision);
    if (waiting)
      stageLabel = manifest
        ? `принят; новая попытка ждёт решения: ${waiting.pendingDecision!.question}`
        : `ждёт вашего решения: ${waiting.pendingDecision!.question}`;
    if (mine.some((p) => p.problems.length)) state = manifest ? state : 'unknown';
    const attention = mine.map(packageAttention).find((text) => text) ?? null;
    const derivedFrom = derivedShotSource(project, scene);
    return {
      id: scene.id,
      title: scene.title ?? titles.get(scene.sequence) ?? scene.sequence,
      original: scene.original,
      start: scene.start_frame / fps,
      end: scene.end_frame_exclusive / fps,
      lipsync: scene.lipsync,
      state,
      stageLabel,
      // Производный план собирается из чужого материала: повтор генерации для него не нужен.
      regenerateProblem: derivedFrom ? derivedShotReason(derivedFrom) : regenerateProblem(project, scene.id, mine, selectedProvider),
      derivedFrom,
      attention,
      asset: manifest
        ? {
            dir: assetDir,
            video,
            original: existingAssetFile(assetDir, manifest.generation?.original?.path)
          }
        : null,
      packages: mine
    };
  });
  const orphans = packages.filter((p) => !scenes.scenes.some((s) => s.id === p.shot));
  if (orphans.length) problems.push(`Пакеты планов, которых нет в реестре: ${orphans.map((p) => basename(p.dir)).join(', ')}.`);
  for (const item of broken) problems.push(`${item.relative}: ${item.reason}. Папка мешает сохранению в очередь; удалите её в очереди или у плана.`);
  return { shots, broken, problems, tools };
}

/**
 * SONGFRAME_PRICING_FILE подменяет базовую таблицу цен в тестовых прогонах.
 * Наблюдения расхода `cost_check learn` пишет в каталог состояния `providers/<id>/pricing-observations.json`, а не в таблицу цен.
 */
export function pricingArgs(): string[] {
  return process.env.SONGFRAME_PRICING_FILE ? ['--pricing', process.env.SONGFRAME_PRICING_FILE] : [];
}

export class Production {
  /** Общие платные адаптеры по id провайдера и виду медиа. */
  private media: Record<string, Partial<Record<MediaKind, PaidMediaProvider>>> | null = null;
  /** Запуск адаптера разрешается только владельцем quote/submit после проверки согласия. */
  setMediaProviders(providers: Record<string, Partial<Record<MediaKind, PaidMediaProvider>>>): void {
    this.media = providers;
  }
  /** Адаптер сохранённого запроса; без подключённых адаптеров (служебные проверки) — null. */
  private paidMedia(provider: string | null | undefined, kind: MediaKind): PaidMediaProvider | null {
    if (!this.media) return null;
    const adapter = this.media[normalizeMediaProvider(provider) ?? '']?.[kind];
    if (!adapter) throw new Error(`Для провайдера ${provider ?? 'не указан'} не подключён исполнитель.`);
    return adapter;
  }
  private readonly operations = new Set<string>();
  private readonly shotJobs = new Map<string, string>();
  private readonly packageJobs = new Map<string, string>();
  private readonly bundleJobs = new Map<string, string>();
  private readonly quotes = new Map<string, { project: string; directory: string; decisionToken: string; quote: ProductionQuote; issued: number }>();
  private quoteSequence = 0;

  isBusy(project: string, packageDir: string): boolean {
    const directory = existsSync(resolve(project, packageDir)) ? realpathSync(resolve(project, packageDir)) : resolve(project, packageDir);
    const shot = readJson<{ shot?: string }>(join(directory, 'workflow.json'))?.shot;
    return (
      this.jobs.get(this.shotJobs.get(`${realpathSync(project)}:${shot}`) ?? '')?.status === 'running' ||
      this.operations.has(directory) ||
      this.jobs.get(this.packageJobs.get(directory) ?? '')?.status === 'running'
    );
  }

  private available(project: string, packageDir: string): string {
    const directory = checkedPackage(project, packageDir);
    if (this.isBusy(project, directory)) throw new Error('Для этого пакета уже выполняется операция. Дождитесь её завершения.');
    return directory;
  }

  private ready(project: string, directory: string, expectedSha: string, decisionToken?: string): PackageView {
    const view = readPackage(project, directory);
    if (view?.sceneChanged) throw new Error(`${SCENE_CHANGED} Оставьте пакет для текущей постановки или подготовьте новый.`);
    if (!view?.decisionToken || view.problems.length || !view?.request?.sha256 || view.request.sha256 !== expectedSha || !/^[a-f0-9]{64}$/.test(expectedSha))
      throw new Error('Показанный запрос изменился. Откройте подтверждение заново.');
    if (!['request_choice', 'ready', 'image_request_choice'].includes(view.stage) || view.request.attemptStatus !== 'prepared')
      throw new Error('Эта попытка уже отправлялась или не готова к отправке.');
    // Универсальная подготовка не разрешает отправить запрос через адаптер другого провайдера.
    if (!isPaidMediaProvider(view.request.provider))
      throw new Error(`Для провайдера ${view.request.provider ?? 'не указан'} не подключён исполнитель отправки.`);
    if (view.pendingDecision && (!decisionToken || decisionToken !== view.decisionToken || !view.pendingDecision.options.includes('send')))
      throw new Error('Вопрос или материалы изменились. Откройте подтверждение заново.');
    return view;
  }

  private async price(project: string, directory: string): Promise<Omit<ProductionQuote, 'token' | 'requestSha'>> {
    // Недоступная оценка остаётся отдельным согласуемым состоянием; сырой ответ CLI может содержать секреты.
    const unknown = (): Omit<ProductionQuote, 'token' | 'requestSha'> => ({
      verdict: 'cost_or_balance_unknown',
      credits: null,
      balance: null,
      reasons: ['Не удалось определить стоимость и остаток кредитов.']
    });
    let result;
    let value: Record<string, unknown>;
    try {
      result = await this.jobs.launcher.run(project, 'cost_check', ['check', '--work-dir', directory, '--json', ...pricingArgs()]);
      const parsed: unknown = JSON.parse(result.stdout);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return unknown();
      value = parsed as Record<string, unknown>;
    } catch {
      return unknown();
    }
    const verdict = value.verdict;
    if (![0, 2].includes(result.code ?? -1) || !['ok', 'insufficient_balance', 'cost_or_balance_unknown'].includes(String(verdict))) return unknown();
    const credits =
      typeof value.estimate_credits === 'number' && Number.isFinite(value.estimate_credits) && value.estimate_credits >= 0 ? value.estimate_credits : null;
    const balance =
      typeof value.balance_credits === 'number' && Number.isFinite(value.balance_credits) && value.balance_credits >= 0 ? value.balance_credits : null;
    const checkedVerdict =
      credits !== null && balance !== null && balance < credits
        ? 'insufficient_balance'
        : verdict === 'ok' && (result.code !== 0 || credits === null || balance === null)
          ? 'cost_or_balance_unknown'
          : verdict;
    return {
      verdict: checkedVerdict as ProductionQuote['verdict'],
      credits,
      balance,
      reasons: Array.isArray(value.reasons) ? value.reasons.filter((r): r is string => typeof r === 'string') : []
    };
  }

  async quote(project: string, packageDir: string, expectedSha: string, decisionToken?: string): Promise<ProductionQuote> {
    const directory = this.available(project, packageDir);
    // Порядок запуска, а не завершения: запоздавшая прежняя оценка не должна вытеснить более новую, которую показывает окно.
    const issued = ++this.quoteSequence;
    const view = this.ready(project, directory, expectedSha, decisionToken);
    const price = await this.price(project, view.request!.dir);
    const current = this.ready(project, directory, expectedSha, decisionToken);
    if (view.decisionToken !== current.decisionToken) throw new Error('Материалы изменились во время проверки стоимости.');
    const quote: ProductionQuote = { token: randomUUID(), requestSha: expectedSha, ...price };
    // Окно может запросить оценку несколько раз (повторный эффект, обновление доступа) и показать любую из них:
    // для тех же материалов действуют несколько последних оценок, оценки прежних материалов сгорают.
    // Отправка всё равно заново сверяет цену и остаток, а сам токен одноразовый.
    for (const [token, record] of this.quotes)
      if (record.directory === directory && (record.decisionToken !== current.decisionToken || record.quote.requestSha !== expectedSha))
        this.quotes.delete(token);
    this.quotes.set(quote.token, { project: realpathSync(project), directory, decisionToken: current.decisionToken!, quote, issued });
    const same = [...this.quotes].filter(([, record]) => record.directory === directory).sort((a, b) => b[1].issued - a[1].issued);
    for (const [token] of same.slice(4)) this.quotes.delete(token);
    return quote;
  }

  constructor(
    private readonly toolsRoot: string | null,
    private readonly jobs: Jobs
  ) {}

  /** Опоры согласуются по одной: вопрос задаётся о первом в плане кандидате, ещё не утверждённом. */
  private async askNextFrame(project: string, directory: string): Promise<void> {
    const current = readPackage(project, directory);
    if (!current || current.pendingDecision) return;
    const frame = current.keyframes.find((item) => item.imagePath && !item.approved);
    if (!frame) return;
    const question = await this.jobs.launcher.run(project, 'shot_workflow', ['ask', '--dir', directory, '--stage', 'keyframes_review', '--frame', frame.id]);
    if (question.code !== 0) throw new Error(`Кандидат сохранён; не удалось записать вопрос об опоре ${frame.id}.`);
  }

  async decide(project: string, packageDir: string, verdict: string, note: string, decisionToken?: string, noteScope?: KeyframeNoteScope): Promise<void> {
    packageDir = this.available(project, packageDir);
    const view = readPackage(project, packageDir);
    if (decisionToken && decisionToken !== view?.decisionToken) throw new Error('Вопрос или материалы изменились. Обновите пакет перед ответом.');
    if (!decisionToken) throw new Error('Обновите вопрос перед ответом.');
    if (verdict === 'send') throw new Error('Используйте отдельное подтверждение запроса со стоимостью.');
    this.operations.add(packageDir);
    try {
      const result = await runTool(
        this.toolsRoot,
        project,
        'shot_workflow',
        [
          'decide',
          '--dir',
          packageDir,
          '--verdict',
          verdict,
          ...(note ? ['--note', note] : []),
          // Охват замечания важен только при доработке опоры: оно уходит в генерацию этой опоры или и следующих.
          ...(verdict === 'revise' && view?.pendingDecision?.frame ? ['--note-scope', noteScope === 'frame' ? 'frame' : 'following'] : [])
        ],
        undefined,
        this.jobs.launcher
      );
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `shot_workflow decide завершился с кодом ${result.code}`);
      if (verdict === 'revise' && view?.stage === 'image_request_choice' && view.request?.attemptStatus === 'prepared') {
        // Неотправленный frozen request остаётся в истории; новая подготовка получает другую папку и новый вопрос.
        const reset = await this.jobs.launcher.run(project, 'shot_workflow', ['set-stage', '--dir', packageDir, 'keyframes_review']);
        if (reset.code !== 0) throw new Error('Замечание сохранено; не удалось вернуться к подготовке изображения.');
      }
      // После утверждения одной опоры следующий уже готовый кандидат (например, свой импорт) сразу получает вопрос.
      if (verdict === 'approve' && view?.pendingDecision?.frame) await this.askNextFrame(project, packageDir);
    } finally {
      this.operations.delete(packageDir);
    }
  }

  async reopenFrame(project: string, packageDir: string, frame: string, note: string, noteScope: KeyframeNoteScope): Promise<void> {
    packageDir = this.available(project, packageDir);
    if (!/^K\d{2}$/.test(frame)) throw new Error('Неизвестная опора.');
    if (!note.trim()) throw new Error('Опишите, что исправить в опоре.');
    this.operations.add(packageDir);
    try {
      const result = await this.jobs.launcher.run(project, 'shot_workflow', [
        'reopen',
        '--dir',
        packageDir,
        frame,
        '--note',
        note.trim(),
        '--note-scope',
        noteScope === 'frame' ? 'frame' : 'following'
      ]);
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || 'Не удалось вернуть опору на доработку.');
      await this.askNextFrame(project, packageDir);
    } finally {
      this.operations.delete(packageDir);
    }
  }

  /** Пользователь подтверждает, что правка сценария не затрагивает материалы неотправленного пакета. */
  keepPackageForScene(project: string, packageDir: string): void {
    packageDir = this.available(project, packageDir);
    const view = readPackage(project, packageDir);
    if (!view?.sceneChanged) throw new Error('Постановка пакета не менялась.');
    if (view.request && view.request.attemptStatus !== 'prepared')
      throw new Error('Попытка уже отправлялась: её материалы относятся к прежней постановке, оставить их для новой нельзя.');
    const workflow = readJson<Workflow>(join(packageDir, 'workflow.json'));
    const current = currentShotFingerprint(project, view.shot);
    if (!workflow || !current || !restampPackage(packageDir, workflow.scene_sha256 ?? null, current))
      throw new Error('Не удалось обновить отпечаток постановки в workflow.json пакета.');
  }

  async setKeyframeNote(project: string, packageDir: string, id: number, active: boolean): Promise<void> {
    packageDir = this.available(project, packageDir);
    if (!Number.isInteger(id) || id < 1) throw new Error('Неизвестное замечание.');
    const result = await this.jobs.launcher.run(project, 'shot_workflow', [
      'set-note',
      '--dir',
      packageDir,
      '--id',
      String(id),
      '--active',
      active ? 'true' : 'false'
    ]);
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || 'Не удалось изменить замечание.');
  }

  /** Отказ от попытки удаляет пакет целиком вместе с оплаченным оригиналом: после него повтор по сохранённому запросу доступен снова. */
  discardAttempt(project: string, packageDir: string): void {
    const directory = this.available(project, packageDir);
    const view = readPackage(project, directory);
    if (!view) {
      // Недописанная папка без workflow.json: удаляется, если в ней нет следов незавершённой отправки.
      const attempt = readJson<{ status?: string }>(join(directory, 'request', 'attempt.json'));
      if (attempt?.status && !['prepared', 'downloaded', 'failed', 'download_failed', 'download_partial'].includes(attempt.status))
        throw new Error(`В папке есть попытка в состоянии «${attempt.status}»: удалять её без результата нельзя.`);
      const local = relative(realpathSync(project), directory).replaceAll('\\', '/');
      for (const draft of montageDraftsUsing(project, local))
        throw new Error(`Папка используется сохранённым черновиком монтажа «${draft}». Сначала удалите черновик.`);
      rmSync(directory, { recursive: true, force: true });
      return;
    }
    if (view.stage === 'accepted') throw new Error('Принятый пакет не удаляется: комплект уже в assets.');
    const status = view.request?.attemptStatus ?? '';
    if (
      [
        'submitting',
        'submission_unknown',
        'submitted',
        'running',
        'watermark_free_pending',
        'outputs_pending',
        'download_pending',
        'downloading',
        'polling'
      ].includes(status)
    )
      throw new Error('Отправка ещё не завершена: сначала получите результат, иначе оплаченная генерация потеряется без файла.');
    const packageRelative = view.relative.replaceAll('\\', '/');
    for (const draft of montageDraftsUsing(project, packageRelative))
      throw new Error(`Пакет используется сохранённым черновиком монтажа «${draft}». Сначала удалите черновик.`);
    rmSync(directory, { recursive: true, force: true });
  }

  /** Возвращает вопрос о полученном результате, если ответ уже записан, а решение нужно принять заново. */
  async reopenQuestion(project: string, packageDir: string): Promise<void> {
    packageDir = this.available(project, packageDir);
    const view = readPackage(project, packageDir);
    if (!view) throw new Error('Пакет не найден. Обновите страницу производства.');
    if (view.pendingDecision) throw new Error('Вопрос уже задан.');
    if (!['downloaded', 'edit_review'].includes(view.stage)) throw new Error('Вернуть можно только вопрос о полученном результате.');
    this.operations.add(packageDir);
    try {
      const result = await runTool(
        this.toolsRoot,
        project,
        'shot_workflow',
        ['ask', '--dir', packageDir, '--stage', view.stage],
        undefined,
        this.jobs.launcher
      );
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `shot_workflow ask завершился с кодом ${result.code}`);
    } finally {
      this.operations.delete(packageDir);
    }
  }

  async park(project: string, packageDir: string): Promise<void> {
    packageDir = this.available(project, packageDir);
    this.operations.add(packageDir);
    try {
      const result = await runTool(this.toolsRoot, project, 'shot_workflow', ['park', '--dir', packageDir], undefined, this.jobs.launcher);
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `shot_workflow park завершился с кодом ${result.code}`);
    } finally {
      this.operations.delete(packageDir);
    }
  }

  /** Точный срез песни для речевого плана: перезаписывается только до отправки, чтобы запрос и приёмка ссылались на один WAV. */
  async prepareSpeech(project: string, packageDir: string, bounds?: { start: number; end: number }): Promise<PackageView> {
    const directory = this.available(project, packageDir);
    const view = readPackage(project, directory);
    if (!view) throw new Error('Пакет не найден.');
    if (view.request?.attemptStatus && view.request.attemptStatus !== 'prepared')
      throw new Error('Запрос этой попытки уже отправлен: её WAV менять нельзя. Подготовьте новую попытку.');
    if (bounds !== undefined && (!Number.isFinite(bounds.start) || !Number.isFinite(bounds.end) || bounds.start < 0 || bounds.end <= bounds.start))
      throw new Error('Конец среза должен быть позже начала, границы — неотрицательные секунды.');
    this.operations.add(directory);
    try {
      const audio = join(directory, 'audio');
      // cut_speech не перезаписывает файлы: прежний срез пакета заменяется новым целиком.
      rmSync(join(audio, 'speech.wav'), { force: true });
      rmSync(join(audio, 'audio-recipe.json'), { force: true });
      const args = ['cut', view.shot, '--out', audio, '--json', ...(bounds ? ['--start', String(bounds.start), '--end', String(bounds.end)] : [])];
      const result = await runTool(this.toolsRoot, project, 'cut_speech', args, undefined, this.jobs.launcher);
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `cut_speech завершился с кодом ${result.code}`);
    } finally {
      this.operations.delete(directory);
    }
    const next = readPackage(project, directory);
    if (!next?.speech) throw new Error('WAV речи не появился в пакете.');
    return next;
  }

  /** Только показанный запрос и одноразовое подтверждение стоимости допускают новую оплату. */
  async submit(
    project: string,
    packageDir: string,
    expectedSha?: string,
    decisionToken?: string,
    quoteToken?: string,
    unknownCostConsentToken?: string
  ): Promise<JobInfo> {
    const directory = this.available(project, packageDir);
    const record = this.quotes.get(quoteToken ?? '');
    // Отправка одноразовая для пакета: вместе с использованным сгорают и остальные оценки этих материалов.
    for (const [token, candidate] of this.quotes) if (token === quoteToken || (record && candidate.directory === record.directory)) this.quotes.delete(token);
    // Согласие относится ровно к показанной оценке и сгорает вместе с её одноразовым token.
    const agreedToUnknownCost = !!record && unknownCostConsentToken === record.quote.token && canAgreeToUnknownCost(record.quote);
    if (
      !record ||
      record.project !== realpathSync(project) ||
      record.directory !== directory ||
      record.quote.requestSha !== expectedSha ||
      !priceAllowsGeneration(record.quote, agreedToUnknownCost)
    )
      throw new Error('Сначала откройте запрос и подтвердите актуальную стоимость.');
    const view = this.ready(project, directory, expectedSha!, decisionToken);
    if (view.decisionToken !== record.decisionToken) throw new Error('Показанные материалы изменились: требуется новое подтверждение.');
    this.operations.add(directory);
    try {
      const price = await this.price(project, view.request!.dir);
      const fresh = this.ready(project, directory, expectedSha!, decisionToken);
      if (
        !priceAllowsGeneration(price, agreedToUnknownCost) ||
        (!agreedToUnknownCost && price.credits !== record.quote.credits) ||
        fresh.decisionToken !== record.decisionToken
      )
        throw new Error('Стоимость, остаток или материалы изменились. Откройте подтверждение заново; отправка не выполнялась.');
      if (fresh.stage === 'ready') {
        // Новый quote и нажатие подтверждения разрешают прежний frozen request; запись вопроса не создаёт новую попытку.
        const stage = await this.jobs.launcher.run(project, 'shot_workflow', ['set-stage', '--dir', directory, 'request_choice']);
        if (stage.code !== 0) throw new Error('Не удалось возобновить отложенный пакет. Отправка не выполнялась.');
        const question = await this.jobs.launcher.run(project, 'shot_workflow', ['ask', '--dir', directory, '--stage', 'request_choice']);
        if (question.code !== 0) throw new Error('Не удалось записать вопрос отложенного запроса. Отправка не выполнялась.');
      }
      if (fresh.request?.kind === 'image' && !fresh.pendingDecision) {
        // Отложенный image-запрос снова подтверждается для того же SHA, а прежний park не выдаётся за send.
        const question = await this.jobs.launcher.run(project, 'shot_workflow', ['ask', '--dir', directory, '--stage', 'image_request_choice']);
        if (question.code !== 0) throw new Error('Не удалось записать новое подтверждение изображения. Отправка не выполнялась.');
      }
      if (fresh.pendingDecision || fresh.stage === 'ready' || fresh.request?.kind === 'image') {
        const result = await this.jobs.launcher.run(project, 'shot_workflow', ['decide', '--dir', directory, '--verdict', 'send']);
        if (result.code !== 0) throw new Error('Не удалось записать подтверждение отправки.');
      }
      const requestDir = fresh.request!.dir;
      const image = fresh.request!.kind === 'image';
      let job: JobInfo | null = null;
      const execute = async (): Promise<void> => {
        job = this.jobs.start('submit', `Отправка ${image ? 'опоры ' + fresh.request!.frameId : fresh.shot}`, project, [
          { tool: 'shot_workflow', args: ['check', '--dir', directory], label: 'проверка материалов' },
          { tool: 'media_request', args: ['submit', '--work-dir', requestDir, '--confirm', expectedSha!], label: 'отправка' },
          { tool: 'cost_check', args: ['learn', '--work-dir', requestDir, ...pricingArgs()], required: false, label: 'запись расхода' },
          { tool: 'shot_workflow', args: ['set-stage', '--dir', directory, image ? 'image_submitted' : 'submitted'], label: 'задание отправлено' },
          ...this.resumeSteps(directory, requestDir, image)
        ]);
      };
      const media = this.paidMedia(fresh.request!.provider, image ? 'image' : 'video');
      if (media) {
        const prepared: PreparedMediaRequest = { provider: media.provider, kind: media.kind, project, requestDir, requestSha: expectedSha! };
        await media.submit(prepared, execute);
      } else await execute();
      if (!job) throw new Error('Исполнитель не создал задание.');
      const started = job as JobInfo;
      this.packageJobs.set(directory, started.id);
      // Явный отказ сервиса оставляет попытку неотправленной: снова задаём вопрос, чтобы пакет можно было исправить или отправить заново.
      const unsubscribe = this.jobs.onFinished((finished) => {
        if (finished.id !== started.id) return;
        unsubscribe();
        const attempt = readJson<{ status?: string }>(join(requestDir, 'attempt.json'));
        if (finished.status !== 'failed' || attempt?.status !== 'prepared') return;
        void this.jobs.launcher
          .run(project, 'shot_workflow', ['ask', '--dir', directory, '--stage', image ? 'image_request_choice' : 'request_choice'])
          .catch(() => undefined);
      });
      return started;
    } finally {
      this.operations.delete(directory);
    }
  }

  /** Подготовка повтора ничего не отправляет: новый пакет снова показывается пользователю. */
  regenerate(project: string, shot: string): JobInfo {
    const key = `${realpathSync(project)}:${shot}`;
    if (this.jobs.get(this.shotJobs.get(key) ?? '')?.status === 'running') throw new Error('Повтор уже подготавливается.');
    const view = viewProduction(project, this.jobs.launcher);
    const currentShot = view.shots.find((s) => s.id === shot);
    if (!currentShot) throw new Error(`План ${shot} не найден. Обновите страницу производства.`);
    const packages = currentShot.packages;
    if (packages.some((pkg) => ['submitting', 'submission_unknown'].includes(pkg.request?.attemptStatus ?? '') || this.isBusy(project, pkg.dir)))
      throw new Error('Сначала выясните исход существующей отправки; новая оплата запрещена.');
    if (currentShot.regenerateProblem) throw new Error(currentShot.regenerateProblem);
    const job = this.jobs.start('regenerate', `Подготовка повтора ${shot}`, project, [
      { tool: 'regenerate_shot', args: [shot, '--json', ...pricingArgs()], label: 'новая попытка без отправки' }
    ]);
    this.shotJobs.set(key, job.id);
    return job;
  }

  private resumeSteps(directory: string, requestDir: string, image = false): Parameters<Jobs['start']>[3] {
    return [
      { tool: 'media_request', args: ['watch', '--work-dir', requestDir, '--max-minutes', '30'], label: 'получение прежнего задания' },
      {
        tool: 'shot_workflow',
        args: ['set-stage', '--dir', directory, image ? 'image_downloaded' : 'downloaded'],
        label: 'результат скачан',
        // watch завершается успешно и для failed: принимать можно только полностью сохранённый результат.
        before: () => {
          const attempt = readJson<{ status?: string; downloads?: { path?: string }[] }>(join(requestDir, 'attempt.json'));
          if (
            attempt?.status !== 'downloaded' ||
            !attempt.downloads?.length ||
            attempt.downloads.some((item) => !item.path || !statSync(join(requestDir, item.path), { throwIfNoEntry: false })?.isFile())
          )
            throw new Error('Результат не получен полностью. Проверьте состояние задания; вопрос приёмки не создан.');
        }
      },
      ...(!image
        ? [
            { tool: 'shot_workflow', args: ['ask', '--dir', directory, '--stage', 'downloaded'], label: 'просмотр результата' },
            { tool: 'contact_sheet', args: ['--package', directory, '--json'], required: false, label: 'техническая сводка' }
          ]
        : [])
    ];
  }

  /** Возобновляется сохранённый generation ID, новая отправка отсутствует в списке шагов. */
  resume(project: string, packageDir: string): JobInfo {
    const directory = this.available(project, packageDir);
    const view = readPackage(project, directory);
    if (!view?.request) throw new Error('В пакете нет попытки.');
    const request = view.request;
    if (!isPaidMediaProvider(request.provider))
      throw new Error(`Для провайдера ${request.provider ?? 'не указан'} не подключён исполнитель получения результата.`);
    if (request.attemptStatus === 'prepared') throw new Error('Запрос ещё не отправлен.');
    if (!request.generationId && !request.manualResult)
      throw new Error(
        'ID задания неизвестен. Проверьте историю генераций сервиса: загрузите найденный результат вручную или отметьте, что задание не создано.'
      );
    const steps: Parameters<Jobs['start']>[3] = [];
    // Этап мог остаться request_choice, если процесс оборвался между ответом сервиса и записью workflow.
    const image = request.kind === 'image';
    if (['request_choice', 'ready', 'image_request_choice'].includes(view.stage))
      steps.push({
        tool: 'shot_workflow',
        args: ['set-stage', '--dir', directory, image ? 'image_submitted' : 'submitted'],
        label: 'восстановление этапа отправки'
      });
    steps.push(...this.resumeSteps(directory, request.dir, image));
    const job = this.jobs.start('submit', `Получение ${view.shot}`, project, steps);
    this.packageJobs.set(directory, job.id);
    return job;
  }

  /** Попытка с неизвестным исходом и без ID: выяснить исход может только пользователь по истории генераций сервиса. */
  private unknownAttempt(project: string, packageDir: string): { directory: string; view: PackageView; request: NonNullable<PackageView['request']> } {
    const directory = this.available(project, packageDir);
    const view = readPackage(project, directory);
    const request = view?.request;
    if (!view || !request || request.generationId || !['submitting', 'submission_unknown'].includes(request.attemptStatus ?? ''))
      throw new Error('Действие доступно только попытке с неизвестным исходом отправки и без ID задания. Обновите пакет.');
    if (!isPaidMediaProvider(request.provider))
      throw new Error(`Для провайдера ${request.provider ?? 'не указан'} не подключён исполнитель получения результата.`);
    return { directory, view, request };
  }

  /** Результат, скачанный пользователем из истории генераций, становится оригиналом попытки без новой отправки. */
  attachResult(project: string, packageDir: string, files: string[]): JobInfo {
    const { directory, view, request } = this.unknownAttempt(project, packageDir);
    if (!files.length || files.some((file) => !isAbsolute(file) || !statSync(file, { throwIfNoEntry: false })?.isFile()))
      throw new Error('Выберите файл результата.');
    const image = request.kind === 'image';
    const steps: Parameters<Jobs['start']>[3] = [];
    if (['request_choice', 'ready', 'image_request_choice'].includes(view.stage))
      steps.push({
        tool: 'shot_workflow',
        args: ['set-stage', '--dir', directory, image ? 'image_submitted' : 'submitted'],
        label: 'восстановление этапа отправки'
      });
    steps.push({ tool: 'media_request', args: ['attach', '--work-dir', request.dir, '--file', ...files], label: 'загрузка результата вручную' });
    steps.push(...this.resumeSteps(directory, request.dir, image));
    const job = this.jobs.start('submit', `Ручной результат ${view.shot}`, project, steps);
    this.packageJobs.set(directory, job.id);
    return job;
  }

  /** Генерации нет в истории сервиса: попытка снова ждёт подтверждения, отправка требует новой оценки и согласия. */
  async markNotCreated(project: string, packageDir: string): Promise<void> {
    const { directory, view, request } = this.unknownAttempt(project, packageDir);
    this.operations.add(directory);
    try {
      const image = request.kind === 'image';
      const result = await this.jobs.launcher.run(project, 'media_request', ['not-created', '--work-dir', request.dir]);
      if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || 'Не удалось отметить, что задание не создано.');
      // Назад по этапам разрешено: пакет возвращается к вопросу о запросе, прежний ответ send больше не действует.
      const stage = image ? 'image_request_choice' : 'request_choice';
      if (view.stage !== stage) {
        const back = await this.jobs.launcher.run(project, 'shot_workflow', ['set-stage', '--dir', directory, stage]);
        if (back.code !== 0) throw new Error((back.stderr || back.stdout).trim() || 'Не удалось вернуть пакет к подтверждению запроса.');
      }
      const question = await this.jobs.launcher.run(project, 'shot_workflow', ['ask', '--dir', directory, '--stage', stage]);
      if (question.code !== 0) throw new Error((question.stderr || question.stdout).trim() || 'Не удалось записать вопрос о запросе.');
    } finally {
      this.operations.delete(directory);
    }
  }

  /** Выбор сохраняет кандидат отдельно от оригинала; утверждение опоры остаётся отдельным вопросом. */
  async selectImage(project: string, packageDir: string, index: number, expectedResultToken: string): Promise<void> {
    const directory = this.available(project, packageDir);
    const view = readPackage(project, directory);
    if (
      !view ||
      view.stage !== 'image_downloaded' ||
      view.pendingDecision ||
      !view.resultToken ||
      view.resultToken !== expectedResultToken ||
      view.request?.kind !== 'image' ||
      !Number.isInteger(index) ||
      index < 0 ||
      !view.request.downloads[index]
    )
      throw new Error('Кандидат изменился или недоступен. Обновите пакет и просмотрите результат.');
    this.operations.add(directory);
    try {
      const request = view.request;
      const media = this.paidMedia(request.provider, 'image');
      if (media)
        media.collect({ provider: media.provider, kind: 'image', project, requestDir: request.dir, requestSha: request.sha256!, frameId: request.frameId });
      const selected = await this.jobs.launcher.run(project, 'shot_workflow', ['select-image', '--dir', directory, '--file', request.downloads[index]]);
      if (selected.code !== 0) throw new Error((selected.stderr || selected.stdout).trim() || 'Не удалось выбрать опору.');
      // Каждая опора утверждается сразу после выбора, не дожидаясь остальных.
      await this.askNextFrame(project, directory);
    } finally {
      this.operations.delete(directory);
    }
  }

  accept(project: string, shot: string, packageDir: string, options: AcceptOptions): JobInfo {
    packageDir = this.available(project, packageDir);
    const view = readPackage(project, packageDir);
    if (view?.request?.kind === 'image') throw new Error('Изображение выбирается как кандидат опоры и утверждается отдельно.');
    if (view?.shot !== shot) throw new Error('Пакет относится к другому плану.');
    if (!view.resultToken || !options.expectedResultToken || options.expectedResultToken !== view.resultToken)
      throw new Error('Результат изменился. Обновите пакет и просмотрите его перед приёмкой.');
    if (view.request?.attemptStatus !== 'downloaded' || !view.request.downloads.length) throw new Error('Сначала получите полный результат задания.');
    // Замена принятого комплекта необратима для индекса сцены: прежний комплект переезжает в assets/replaced только по явному согласию.
    const accepted = existsSync(join(project, 'assets', 'shots', shot, 'manifest.json'));
    if (accepted && !options.replaceExisting) throw new Error('У плана уже есть принятый комплект. Подтвердите замену в диалоге приёмки.');
    // UI задаёт секунды, accept_shot принимает границы в кадрах; неточные границы не округляем молча.
    const cutFrame = (seconds: number | undefined): number => {
      if (
        typeof seconds !== 'number' ||
        !Number.isFinite(seconds) ||
        seconds < 0 ||
        !Number.isSafeInteger(Math.round(seconds * FPS)) ||
        Math.abs(seconds * FPS - Math.round(seconds * FPS)) > 1e-6
      )
        throw new Error(`Границы участка должны быть конечными неотрицательными секундами на сетке ${FPS} кадров/с.`);
      return Math.round(seconds * FPS);
    };
    let edit = ['--full'];
    if (options.mode !== 'full') {
      const first = cutFrame(options.cutStart);
      const last = cutFrame(options.cutEnd);
      if (last <= first) throw new Error('Конец участка должен быть позже начала.');
      edit = ['--cut', `${first}:${last}`];
    }
    const extra = [
      ...(options.speed && options.speed !== '1' ? ['--speed', options.speed] : []),
      ...(options.holdFirst ? ['--hold-first', String(options.holdFirst)] : []),
      ...(options.holdLast ? ['--hold-last', String(options.holdLast)] : [])
    ];
    // Речевой план принимается только с точным срезом песни, подготовленным в пакете.
    const scenes = readJson<{ scenes?: { id?: string; lipsync?: boolean }[] }>(join(project, 'plan', 'scenes.json'));
    const lipsync = !!scenes?.scenes?.find((scene) => scene.id === shot)?.lipsync;
    if (lipsync && !view.speech) throw new Error('Речевой план: сначала подготовьте WAV речи в блоке «Речь» этого пакета.');
    const audio = lipsync && view.speech ? ['--audio', view.speech.path, '--audio-recipe', view.speech.recipe] : [];
    const job = this.jobs.start('accept', `Приёмка ${shot}`, project, [
      {
        tool: 'accept_shot',
        args: [shot, '--package', packageDir, ...edit, ...extra, ...audio, ...(accepted ? ['--replace'] : []), '--clean'],
        label: accepted ? 'замена комплекта в assets' : 'перенос в assets'
      }
    ]);
    this.packageJobs.set(packageDir, job.id);
    return job;
  }

  /** Пакет для монтажёра: папка должна быть пустой; внутри проекта допускается только plan/batches. */
  exportBundle(project: string, options: ExportBundleOptions): JobInfo {
    const target = resolve(options.target);
    if (!isAbsolute(options.target)) throw new Error('Укажите абсолютный путь папки пакета.');
    const inside = target.startsWith(resolve(project) + '/') || target.startsWith(resolve(project) + '\\');
    if (inside && !target.startsWith(join(resolve(project), 'plan', 'batches')))
      throw new Error('Внутри проекта пакет можно собирать только в plan/batches; иначе выберите папку вне проекта.');
    if (existsSync(target) && readdirSync(target).length) throw new Error(`Папка не пуста: ${target}`);
    mkdirSync(target, { recursive: true });
    // С копированием в пакет входят карточки неготовых планов: их рисует обновление представлений.
    const steps = options.copy ? [{ tool: 'update_scene_views', args: [], required: false, label: 'карточки и представления' }] : [];
    const job = this.jobs.start('tool', `Пакет для монтажёра${options.copy ? ' с медиа' : ''}`, project, [
      ...steps,
      { tool: 'export_edit_bundle', args: ['--out', target, ...(options.copy ? ['--copy'] : [])], label: 'Сборка пакета для монтажёра' }
    ]);
    this.bundleJobs.set(target, job.id);
    return job;
  }

  /** Удаление доступно после завершения сборки; весь пакет содержит только экспорт и его копии медиа. */
  removeBundle(project: string, path: string): void {
    const directory = checkedBuiltOutput(project, path, 'directory');
    if (this.jobs.get(this.bundleJobs.get(directory) ?? '')?.status === 'running') throw new Error('Пакет ещё собирается. Дождитесь завершения задания.');
    checkedBuiltOutput(project, join(directory, 'bundle.json'), 'file');
    if (!listBundles(project).some((bundle) => resolve(bundle.dir) === directory)) throw new Error('Собранный пакет не найден. Обновите список.');
    // Старые рабочие пакеты определяются по запросу, даже если workflow.json ещё не использовался.
    if (['workflow.json', 'request.json', join('request', 'request.json')].some((marker) => existsSync(join(directory, marker))))
      throw new Error('Нельзя удалить рабочий пакет сцены как пакет для монтажёра.');
    rmSync(directory, { recursive: true });
  }

  contactSheet(project: string, packageDir: string): JobInfo {
    packageDir = this.available(project, packageDir);
    const job = this.jobs.start('contact_sheet', `Сводка ${basename(packageDir)}`, project, [
      { tool: 'contact_sheet', args: ['--package', packageDir, '--json'], label: 'контактный лист' }
    ]);
    this.packageJobs.set(packageDir, job.id);
    return job;
  }
}

/** Названия сохранённых черновиков монтажа, чьи клипы лежат в указанной папке пакета. */
function montageDraftsUsing(project: string, relative: string): string[] {
  const folder = join(project, 'plan', 'montage');
  if (!existsSync(folder)) return [];
  const names: string[] = [];
  for (const file of readdirSync(folder)) {
    if (!file.endsWith('.json')) continue;
    const draft = readJson<{ name?: string; clips?: { path?: string }[] }>(join(folder, file));
    if (draft?.clips?.some((clip) => typeof clip.path === 'string' && clip.path.replaceAll('\\', '/').startsWith(relative + '/')))
      names.push(draft.name ?? file);
  }
  return names;
}

/** Собранные пакеты внутри plan/batches: папки с bundle.json. Пакеты вне проекта приложение не отслеживает. */
export function listBundles(project: string): BundleInfo[] {
  const folder = join(project, 'plan', 'batches');
  if (!existsSync(folder)) return [];
  const result: BundleInfo[] = [];
  for (const entry of readdirSync(folder, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const bundlePath = join(folder, entry.name, 'bundle.json');
    const bundle = readJson<{ shots?: { status?: string }[] }>(bundlePath);
    if (!bundle || !Array.isArray(bundle.shots)) continue;
    const shots = bundle.shots ?? [];
    result.push({
      dir: join(folder, entry.name),
      createdAt: statSync(bundlePath).mtime.toISOString(),
      shots: shots.length,
      videos: shots.filter((s) => s.status === 'video').length,
      copied: existsSync(join(folder, entry.name, 'media'))
    });
  }
  return result.sort((a, b) => (a.createdAt! < b.createdAt! ? 1 : -1));
}
