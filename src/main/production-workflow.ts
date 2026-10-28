/** Один план и один пакет проходят подготовку предложений; проект меняется только отдельным Apply. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentJob } from '@shared/agents';
import type {
  ProductionFrameCandidate,
  ProductionFramePrompt,
  ProductionImagesInput,
  ProductionPass,
  ProductionProposal,
  ProductionRequestDraft,
  ProductionWorkflowStart,
  ProductionWorkflowView
} from '@shared/production-workflow';
import type { DurationRule } from '@shared/types';
import { isMediaProvider, mediaProviderInfo, mediaProviderTitles } from '@shared/media-providers';
import { readProjectSettings } from './checks';
import type { AgentManager } from './agent-manager';
import type { PythonLauncher } from './python-launcher';
import { cliArgs } from './production';
import { readKlingCapabilities } from './kling-capabilities';
import { cachedFileDigest } from './animatic-freshness';
import { sourceInputDigest, upgradeSourceInputSnapshot } from './source-input-hash';
import { checkFrameCandidates, checkProductionCapabilities, parseProductionProposal, productionPath, record, type ProposalRules } from './production-proposal';
import { applyProductionPackage, productionPackageVideoPaid, writeProductionJson } from './production-workflow-apply';
export { recoverInterruptedProductionApplies } from './production-workflow-apply';

interface Options {
  localDir: string;
  agents: Pick<AgentManager, 'start' | 'get' | 'list'>;
  toolsRoot: () => string | null;
  launcher: () => PythonLauncher;
  isScenarioApproved: (project: string) => boolean;
  isPackageBusy?: (project: string, packageDir: string) => boolean;
  generateImages: (input: ProductionImagesInput) => AgentJob;
  collectImages: (job: AgentJob) => ProductionFrameCandidate[];
  /** Kling готовит один запрос опоры; отправка остаётся за общим quote/submit. */
  prepareImageRequest?: (input: ProductionImagesInput) => Promise<void>;
  prepareVideoRequest?: (input: {
    project: string;
    shot: string;
    requestDir: string;
    prompt: string;
    draft: ProductionRequestDraft;
    durationConstraint: { windowSeconds: number; rule: DurationRule };
  }) => Promise<void>;
}
interface Frame {
  id: string;
  role: 'first' | 'middle' | 'last';
  time_seconds: number;
  path?: string;
  approved?: boolean;
  sha256?: string;
}
interface Workflow {
  shot: string;
  stage: string;
  executor?: string;
  request_dir?: string;
  description_approved?: boolean;
  image_request_dir?: string;
  image_requests?: { frame_id: string; request_dir: string; request_sha256: string }[];
  timing?: { request_seconds?: number };
  keyframes?: Frame[];
  prompt?: { path?: string; approved?: boolean; sha256?: string };
  approved_prompt_sha256?: string;
  decision?: { stage: string; verdict: string; note?: string } | null;
  pending_decision?: { executor?: string; stage: string } | null;
}
interface Stored {
  proposal: ProductionProposal;
  packageDir: string | null;
  target: string;
  hashes: Record<string, string | null>;
  rules: ProposalRules;
  imageJob?: boolean;
  imageHashes?: Record<string, string>;
  capabilities?: unknown;
}
interface Context {
  project: string;
  shot: string;
  packageDir: string | null;
  workflow: Workflow | null;
  scene: Record<string, unknown>;
  cast: unknown;
  references: Record<string, unknown>;
  settings: Record<string, unknown>;
  window: number;
  durationRule: DurationRule;
  framePrompts: ProductionFramePrompt[];
  allowedPaths: string[];
  managed: boolean;
  paid: boolean;
  problems: string[];
}
const digest = (data: string | Buffer): string => createHash('sha256').update(data).digest('hex');
const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
function json(path: string): unknown {
  return existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
}
function text(path: string): string {
  return existsSync(path) ? readFileSync(path, 'utf8') : '';
}
function rel(project: string, path: string): string {
  return relative(project, path).split('\\').join('/');
}
function packagePath(project: string, path: string): string {
  const target = productionPath(project, path);
  if (!/^plan\/(batches|awaiting)\/[^/]+$/.test(rel(project, target))) throw new Error('Выберите отдельный пакет в plan/batches или plan/awaiting.');
  return target;
}
function nextPackage(project: string, shot: string): string {
  let number = 1;
  while (existsSync(join(project, 'plan/batches', `${shot}-attempt-${String(number).padStart(2, '0')}`))) number++;
  return join(project, 'plan/batches', `${shot}-attempt-${String(number).padStart(2, '0')}`);
}
// Один общий кэш читает большие исходники блоками; недоступный файл не считается отсутствующим.
function requiredFileDigest(path: string): string {
  const hash = cachedFileDigest(path);
  if (hash === null) throw new Error(`Не удалось прочитать файл: ${path}`);
  return hash;
}
function snapshot(project: string, packageDir: string | null, target: string, allowed: string[]): Record<string, string | null> {
  const paths = new Set(['plan/project.json', 'plan/scenes.json', 'plan/cast.json', 'plan/treatment.json', 'source/manifest.json', ...allowed]);
  const walk = (path: string): void => {
    const local = rel(project, path);
    if (!existsSync(path)) {
      paths.add(local);
      return;
    }
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Пакет содержит ссылку: ${local}`);
    if (stat.isDirectory()) {
      paths.add(`${local}/`);
      for (const name of readdirSync(path).sort()) walk(join(path, name));
    } else if (stat.isFile()) paths.add(local);
  };
  if (packageDir) walk(packageDir);
  if (target !== packageDir) walk(target);
  return Object.fromEntries(
    [...paths].sort().map((path) => {
      const full = productionPath(project, path);
      // Обложка оформляет проект и не меняет входы уже подготовленного производственного предложения.
      return [
        path,
        path === 'source/manifest.json'
          ? sourceInputDigest(project)
          : !existsSync(full)
            ? null
            : path.endsWith('/')
              ? digest(JSON.stringify(readdirSync(full).sort()))
              : requiredFileDigest(full)
      ];
    })
  );
}
function sameSnapshot(project: string, stored: Stored): boolean {
  const current = snapshot(project, stored.packageDir, stored.target, stored.rules.allowedPaths);
  return JSON.stringify(current) === JSON.stringify(stored.hashes);
}
function approvedFrames(context: Context): boolean {
  const frames = context.workflow?.keyframes ?? [];
  return (
    frames.length >= 2 &&
    frames.every(
      (frame) =>
        frame.approved &&
        frame.path &&
        frame.sha256 &&
        existsSync(productionPath(context.project, join(context.packageDir!, frame.path))) &&
        cachedFileDigest(productionPath(context.project, join(context.packageDir!, frame.path))) === frame.sha256
    )
  );
}
function promptApproved(context: Context): boolean {
  const prompt = context.workflow?.prompt;
  if (!prompt?.approved || !prompt.path || !context.workflow?.approved_prompt_sha256 || !context.packageDir) return false;
  const path = productionPath(context.project, join(context.packageDir, prompt.path));
  return existsSync(path) && cachedFileDigest(path) === context.workflow.approved_prompt_sha256;
}
function stageFor(context: Context): Exclude<ProductionPass, 'frames'> | null {
  const workflow = context.workflow;
  if (!workflow) return 'description';
  if (workflow.pending_decision) return null;
  if (workflow.decision?.verdict === 'revise') {
    // Повтор сохранённого запроса не содержит утверждений предыдущих этапов: доработка возвращает к доступному шагу.
    // Замечания к опорам сначала меняют их постановку, иначе генерация повторила бы прежние тексты изображений.
    switch (workflow.decision.stage) {
      case 'description_review':
      case 'keyframes_review':
      case 'image_request_choice':
        return 'description';
      case 'prompt_review':
        return approvedFrames(context) ? 'prompt' : 'description';
      case 'request_choice':
        return approvedFrames(context) ? (promptApproved(context) ? 'request' : 'prompt') : 'description';
      default:
        return null;
    }
  }
  if (promptApproved(context) && !workflow.request_dir) return 'request';
  if (approvedFrames(context) && !promptApproved(context)) return 'prompt';
  return null;
}
function rulesFor(context: Context, stage: ProductionPass): ProposalRules {
  return {
    project: context.project,
    stage,
    windowSeconds: context.window,
    durationRule: context.durationRule,
    requestSeconds: context.workflow?.timing?.request_seconds ?? null,
    allowedPaths: context.allowedPaths,
    framePrompts: context.framePrompts
  };
}

export class ProductionWorkflow {
  private readonly busy = new Set<string>();
  constructor(private readonly options: Options) {}
  private key(project: string, shot: string): string {
    return `${project}\0${shot}`;
  }
  private path(project: string, shot: string): string {
    return join(this.options.localDir, 'production-workflow', `${digest(this.key(project, shot))}.json`);
  }
  private checkedStored(project: string, value: unknown): Stored | null {
    if (
      !record(value) ||
      !record(value.proposal) ||
      !record(value.hashes) ||
      !record(value.rules) ||
      typeof value.target !== 'string' ||
      (value.packageDir !== null && typeof value.packageDir !== 'string') ||
      value.rules.project !== project ||
      typeof value.proposal.id !== 'string' ||
      !['running', 'ready', 'invalid', 'failed', 'interrupted', 'applied'].includes(String(value.proposal.status))
    )
      return null;
    packagePath(project, value.target);
    if (value.packageDir !== null) packagePath(project, value.packageDir as string);
    return value as unknown as Stored;
  }
  private read(project: string, shot: string): Stored | null {
    try {
      const value = this.checkedStored(project, json(this.path(project, shot)));
      if (value) upgradeSourceInputSnapshot(value.hashes, project);
      return value;
    } catch {
      return null;
    }
  }
  private write(project: string, shot: string, stored: Stored): void {
    writeProductionJson(this.path(project, shot), stored);
  }
  /** До смены обложки переводим только доказуемо актуальные старые снимки по прежним байтам описи. */
  preserveSourceDecoration(path: string): void {
    const project = realpathSync(path);
    const directory = join(this.options.localDir, 'production-workflow');
    if (!existsSync(directory)) return;
    for (const name of readdirSync(directory)) {
      if (!/^[a-f0-9]{64}\.json$/.test(name)) continue;
      const file = join(directory, name);
      let stored: Stored | null;
      try {
        stored = this.checkedStored(project, json(file));
      } catch {
        // Повреждённые записи и снимки других проектов не мешают сохранению исходников.
        continue;
      }
      if (stored && upgradeSourceInputSnapshot(stored.hashes, project)) writeProductionJson(file, stored);
    }
  }
  private context(path: string, shot: string, requested?: string): Context {
    if (!/^M\d{2}(?:\.\d+)?$/.test(shot)) throw new Error('Укажите один явный ID плана Mxx.');
    const project = realpathSync(path);
    const scenes = json(join(project, 'plan/scenes.json'));
    if (!record(scenes) || !Array.isArray(scenes.scenes)) throw new Error('Нет корректного plan/scenes.json.');
    const scene = scenes.scenes.find((scene) => record(scene) && scene.id === shot);
    if (!record(scene)) throw new Error(`План ${shot} отсутствует в реестре.`);
    const fps = Number(scenes.fps);
    const window = (Number(scene.end_frame_exclusive) - Number(scene.start_frame)) / fps;
    if (!Number.isFinite(window) || window <= 0) throw new Error('Неверное кадровое окно плана.');
    const settings = (readProjectSettings(project).generation?.video ?? {}) as Record<string, unknown>;
    const durationRule = settings.duration_rule;
    const problems: string[] = [];
    if (
      !['min_supported_strictly_greater_than_window', 'min_supported_not_less_than_window', 'exact_window'].includes(String(durationRule)) ||
      typeof settings.provider !== 'string' ||
      typeof settings.resolution !== 'string' ||
      typeof settings.aspect_ratio !== 'string' ||
      typeof settings.watermark !== 'boolean' ||
      !isMediaProvider(settings.provider, 'video')
    )
      problems.push(`Заполните настройки генерации видео проекта: поддерживается провайдер ${mediaProviderTitles('video')}.`);
    const packageDir = requested ? packagePath(project, requested) : null;
    let workflow: Workflow | null = null;
    if (packageDir) {
      const value = json(join(packageDir, 'workflow.json'));
      if (!record(value) || value.shot !== shot || typeof value.stage !== 'string') throw new Error('Пакет отсутствует или относится к другому плану.');
      workflow = value as unknown as Workflow;
    }
    const managed = !workflow || (workflow.executor ?? workflow.pending_decision?.executor) === 'app';
    if (!managed) problems.push('Этот пакет ведёт внешний агент; продолжение остаётся за ним. Для работы в приложении подготовьте новую попытку.');
    const cast = json(join(project, 'plan/cast.json'));
    const references: Record<string, unknown> = {};
    const allowed = new Set<string>();
    const addSource = (path: unknown): void => {
      if (typeof path !== 'string' || !path || isAbsolute(path)) return;
      const local = path.startsWith('source/') ? path : `source/${path}`;
      const full = productionPath(project, local);
      if (existsSync(full) && lstatSync(full).isFile()) allowed.add(rel(project, full));
    };
    if (Array.isArray(scene.references) && record(scenes.references))
      for (const id of scene.references) {
        if (typeof id !== 'string') continue;
        const reference = scenes.references[id];
        if (record(reference)) {
          references[id] = reference;
          addSource(reference.path);
        }
      }
    const entities =
      record(cast) && Array.isArray(cast.entities)
        ? cast.entities.filter(
            (entity) => record(entity) && (entity.kind === 'world' || (Array.isArray(scene.references) && scene.references.includes(entity.id)))
          )
        : [];
    for (const entity of entities) if (record(entity) && Array.isArray(entity.images)) for (const image of entity.images) addSource(image);
    const manifest = json(join(project, 'source/manifest.json'));
    if (record(manifest))
      for (const key of ['track', 'lyrics', 'idea']) {
        const entry = manifest[key];
        if (record(entry)) addSource(entry.path);
      }
    if (packageDir)
      for (const frame of workflow?.keyframes ?? [])
        if (frame.approved && frame.path) {
          const full = productionPath(project, join(packageDir, frame.path));
          if (existsSync(full)) allowed.add(rel(project, full));
        }
    let framePrompts: ProductionFramePrompt[] = [];
    if (packageDir) {
      const raw = json(join(packageDir, 'keyframe-prompts.json'));
      if (Array.isArray(raw)) framePrompts = raw as ProductionFramePrompt[];
    }
    return {
      project,
      shot,
      packageDir,
      workflow,
      scene: {
        ...scene,
        visual_direction: scenes.visual_direction,
        sequence_direction: Array.isArray(scenes.sequences) ? scenes.sequences.find((item) => record(item) && item.id === scene.sequence) : null
      },
      cast: entities,
      references,
      settings,
      window,
      durationRule: durationRule as DurationRule,
      framePrompts,
      allowedPaths: [...allowed].sort(),
      managed,
      paid: packageDir ? productionPackageVideoPaid(packageDir) : false,
      problems
    };
  }
  private refresh(context: Context, stored: Stored | null): AgentJob | null {
    if (!stored) return null;
    const proposal = stored.proposal;
    const job = this.options.agents.get(proposal.jobId);
    try {
      proposal.stale =
        proposal.status !== 'applied' &&
        (!sameSnapshot(context.project, stored) ||
          Object.entries(stored.imageHashes ?? {}).some(([path, hash]) => !existsSync(path) || cachedFileDigest(path) !== hash));
    } catch {
      proposal.stale = true;
    }
    if (proposal.status !== 'running') return job;
    if (!job || job.project !== context.project || job.status === 'interrupted') {
      proposal.status = 'interrupted';
      proposal.message = 'Задание прервано; подготовьте новое предложение.';
    } else if (job.status === 'running') return job;
    else if (job.status !== 'completed' || job.exitCode !== 0) {
      proposal.status = 'failed';
      proposal.message = job.message || 'Агент не завершил подготовку предложения.';
    } else {
      try {
        const raw = stored.imageJob ? JSON.stringify({ schemaVersion: 1, stage: 'frames', images: this.options.collectImages(job) }) : job.result;
        proposal.after = parseProductionProposal(raw, stored.rules);
        checkProductionCapabilities(proposal.after, stored.rules, stored.capabilities, context.settings);
        if (proposal.after.stage === 'frames')
          stored.imageHashes = Object.fromEntries(proposal.after.images.map((image) => [image.path, requiredFileDigest(image.path)]));
        proposal.status = 'ready';
      } catch (error) {
        proposal.status = 'invalid';
        proposal.message = message(error);
      }
    }
    this.write(context.project, context.shot, stored);
    return job;
  }
  view(project: string, shot: string, packageDir?: string): ProductionWorkflowView {
    const canonical = realpathSync(project);
    const stored = this.read(canonical, shot);
    // Отсутствующий выбор означает новую подготовку; созданный пакет Apply возвращает явно.
    const context = this.context(canonical, shot, packageDir);
    const relevant =
      stored && (stored.proposal.status === 'applied' ? stored.target === context.packageDir : stored.packageDir === context.packageDir) ? stored : null;
    const job = this.refresh(context, relevant);
    const busy =
      this.busy.has(this.key(canonical, shot)) ||
      this.options.agents.list(canonical).some((job) => job.status === 'running') ||
      (!!context.packageDir && !!this.options.isPackageBusy?.(canonical, context.packageDir));
    const pending = !!context.workflow?.pending_decision;
    const descriptionApproved =
      context.workflow?.description_approved ?? (context.workflow?.decision?.stage === 'description_review' && context.workflow.decision.verdict === 'approve');
    const frameRevision = context.workflow?.decision?.stage === 'keyframes_review' && context.workflow.decision.verdict === 'revise';
    const proposalPending = !!relevant && ['running', 'ready'].includes(relevant.proposal.status);
    const enabled = !busy && !proposalPending && context.managed && !context.problems.length && !pending && !context.paid;
    const imagePhase = context.workflow?.stage?.startsWith('image_');
    const imageEnabled =
      !busy &&
      context.managed &&
      !context.problems.some((problem) => !problem.startsWith('Заполните настройки генерации видео')) &&
      !pending &&
      !context.paid &&
      !imagePhase;
    const scenarioApproved = this.options.isScenarioApproved(canonical);
    const framesApproved = approvedFrames(context);
    const nextStage = stageFor(context);
    const common = busy
      ? 'идёт задание агента или операция пакета'
      : proposalPending
        ? 'сначала примените или отклоните текущее предложение'
        : pending
          ? 'сначала ответьте на вопрос согласования в карточке пакета'
          : null;
    const reasons = {
      prepare: busy
        ? 'идёт задание агента или операция пакета'
        : imagePhase
          ? 'сначала завершите согласование или получение изображения'
          : !scenarioApproved
            ? 'сценарий не утверждён в приложении: утвердите кастинг, трактовку и сцены на странице «Сценарий»'
            : (context.problems.find((problem) => !problem.startsWith('Этот пакет')) ?? null),
      continue: !context.packageDir
        ? 'нужен выбранный пакет с принятым описанием и опорами'
        : (common ??
          (context.paid
            ? 'попытка уже отправлена: дальше только повтор или возврат с замечанием'
            : !context.managed
              ? 'пакет ведёт внешний агент'
              : context.problems.length
                ? context.problems.join(' ')
                : imagePhase
                  ? 'сначала завершите согласование или получение изображения'
                  : !nextStage || nextStage === 'description'
                    ? framesApproved
                      ? 'опоры приняты, видеопромпт готовится этой кнопкой после принятия описания'
                      : descriptionApproved
                        ? 'сначала создайте и примите опоры'
                        : 'сначала примените и примите описание плана'
                    : null)),
      frames: !context.packageDir
        ? 'нужен выбранный пакет с принятым описанием'
        : (common ??
          (context.paid
            ? 'попытка уже отправлена'
            : framesApproved
              ? 'опоры уже приняты'
              : !context.framePrompts.length
                ? 'в пакете нет плана опор: примените описание с промптами опор'
                : !(descriptionApproved || frameRevision)
                  ? 'сначала примите описание плана'
                  : imagePhase
                    ? 'сначала завершите согласование или получение изображения'
                    : null))
    };
    return {
      project: canonical,
      shot,
      packageDir: context.packageDir,
      managed: context.managed,
      busy,
      stage: context.workflow?.stage ?? null,
      reasons,
      canPrepare: !busy && !imagePhase && scenarioApproved && !context.problems.some((problem) => !problem.startsWith('Этот пакет')),
      canContinue: enabled && !imagePhase && !!stageFor(context) && stageFor(context) !== 'description',
      // Пока у пакета есть вопрос, замечание вводится в его карточке; панель подхватывает сохранённый ответ «вернуть».
      canRevise: !busy && !proposalPending && !imagePhase && !!context.packageDir && context.managed && !context.problems.length && !pending,
      canGenerateFrames:
        imageEnabled && !!context.packageDir && !approvedFrames(context) && !!context.framePrompts.length && (descriptionApproved || frameRevision),
      paid: context.paid,
      imageProvider: readProjectSettings(canonical).generation?.image?.provider,
      framePrompts: context.framePrompts,
      problems: context.problems,
      proposal: relevant?.proposal ?? null,
      job
    };
  }
  async start(input: ProductionWorkflowStart): Promise<ProductionWorkflowView> {
    if (
      !input ||
      !['prepare', 'revise', 'continue'].includes(input.action) ||
      (input.note !== undefined && typeof input.note !== 'string') ||
      (input.stage !== undefined && !['description', 'prompt', 'request'].includes(input.stage))
    )
      throw new Error('Неверные параметры подготовки производства.');
    const context = this.context(input.project, input.shot, input.packageDir);
    const view = this.view(context.project, input.shot, input.packageDir);
    if (context.workflow?.stage.startsWith('image_'))
      throw new Error('Сначала завершите согласование или получение текущего изображения. Новая отправка автоматически не создаётся.');
    if (view.busy) throw new Error('Дождитесь завершения текущего задания.');
    const existing = this.read(context.project, input.shot);
    if (existing && ['running', 'ready'].includes(existing.proposal.status)) throw new Error('Сначала примените или отклоните текущее предложение.');
    let stage: Exclude<ProductionPass, 'frames'>;
    const newPackage = input.action === 'prepare' || (context.paid && input.action === 'revise');
    if (newPackage) {
      if (!view.canPrepare) throw new Error('Сначала утвердите актуальный сценарий и настройки генерации.');
      stage = 'description';
    } else {
      if (!context.packageDir || !context.managed || context.paid || context.problems.length)
        throw new Error(context.problems.join(' ') || 'Выберите доступный пакет приложения.');
      if (context.workflow?.pending_decision) throw new Error('Сначала ответьте на текущий вопрос согласования.');
      stage =
        input.stage ??
        stageFor(context) ??
        (input.action === 'revise' ? (promptApproved(context) ? 'request' : approvedFrames(context) ? 'prompt' : 'description') : null)!;
      if (!stage) throw new Error('На этом этапе требуется согласование описания или опор.');
      const appropriate = stage === 'description' ? true : stage === 'prompt' ? approvedFrames(context) : promptApproved(context);
      if (!appropriate || (input.action === 'continue' && stage !== stageFor(context))) throw new Error('Запрошенный этап ещё не доступен.');
    }
    const key = this.key(context.project, input.shot);
    this.busy.add(key);
    try {
      const root = this.options.toolsRoot();
      if (!root) throw new Error('Корень комплекса не найден.');
      const hashes = snapshot(
        context.project,
        context.packageDir,
        newPackage ? nextPackage(context.project, input.shot) : context.packageDir!,
        context.allowedPaths
      );
      const target = newPackage ? nextPackage(context.project, input.shot) : context.packageDir!;
      const launcher = this.options.launcher();
      const briefs: Record<string, unknown> = {};
      for (const phase of ['before', 'after']) {
        const result = await launcher.run(context.project, 'continuity_brief', [input.shot, '--phase', phase, '--json']);
        if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || 'Не удалось получить врезку непрерывности.');
        briefs[phase] = JSON.parse(result.stdout);
      }
      const reports: unknown[] = [];
      const discoveryProblems: string[] = [];
      const commands = stage === 'request' ? ['image_to_video', 'text_to_video', 'omni_ref_video', 'motion_control'] : ['image_to_video'];
      try {
        // Производство использует тот же снимок, что и настройки, без отдельных who_am_i для каждой команды.
        const catalog = await readKlingCapabilities(launcher, context.project, cliArgs(), commands);
        reports.push(...catalog.reports);
        discoveryProblems.push(...catalog.problems.map((problem) => `${problem.command}: ${problem.message}`));
      } catch (error) {
        discoveryProblems.push(message(error));
      }
      const capabilities: unknown = reports;
      const capabilitiesProblem = discoveryProblems.join(' ');
      if (stage === 'request' && !reports.length)
        throw new Error(`Не удалось получить актуальные модели Kling: ${capabilitiesProblem || 'нет объявлений аккаунта'}`);
      const rules = rulesFor(context, stage);
      const skill = [
        text(join(root, 'skills/ai-clip-scene/SKILL.md')),
        text(join(root, 'skills/ai-clip-scene/references/app-proposal.md')),
        text(join(root, 'skills/ai-clip-scene/references/prompt-template.md'))
      ].join('\n\n');
      const prompt =
        `${skill}\n\nРежим приложения: output=proposal, stage=${stage}. Верни ровно один JSON без Markdown, записей файлов, shell и вызовов инструментов. ` +
        'Форма: description={"schemaVersion":1,"stage":"description","description":"текст","requestSeconds":целое,"keyframes":[{"id":"K01","role":"first","timeSeconds":0,"prompt":"полный промпт изображения","referencePaths":["source/..."]},...,{"id":"KNN","role":"last","timeSeconds":requestSeconds,"prompt":"...","referencePaths":[]}]}; ' +
        'prompt={"schemaVersion":1,"stage":"prompt","prompt":"полный видеопромпт"}; request={"schemaVersion":1,"stage":"request","request":{"model":"точное имя из capabilities","command":"image_to_video|text_to_video|omni_ref_video|motion_control","parameters":{"duration":requestSeconds,...параметры capabilities},"inputs":[{"flag":"input","slot":"image_1","path":"объявленный путь","role":"first"}],"outputs":1}}. ' +
        'Никаких других полей. ID опор K01,K02,... подряд, first на 0 и last на requestSeconds, middle строго между. Сохраняй утверждённую постановку, внешность и непрерывность. ' +
        'settings.model — необязательное предпочтение. Сначала выбери по capabilities модель, совместимую с длительностью, разрешением, пропорциями и всеми референсами задачи. ' +
        'Если предпочтение несовместимо, предложи другую модель и её собственные объявленные параметры; не переноси флаги другой модели и не уменьшай требования ради предпочтения. ' +
        'Соблюдай settings.duration_rule и выбери ближайшую поддерживаемую длительность, если capabilities доступны. Не выдумывай возможности моделей, путь WAV и цену. Для липсинка нужен готовый точный WAV; если его нет, сообщи диагностическую ошибку вместо произвольной команды. Пути только из allowedPaths.';
      const agentContext = JSON.stringify({
        stage,
        scene: context.scene,
        shot: context.scene,
        cast: context.cast,
        references: context.references,
        brief: briefs,
        settings: context.settings,
        existing: context.workflow,
        description: context.packageDir ? text(join(context.packageDir, 'description.md')) : null,
        prompt: context.packageDir ? text(join(context.packageDir, 'video-prompt.txt')) : null,
        keyframes: context.framePrompts,
        allowedPaths: context.allowedPaths,
        windowSeconds: context.window,
        capabilities,
        capabilitiesProblem,
        note: input.note?.trim() || context.workflow?.decision?.note || ''
      });
      const check: Stored = {
        proposal: { id: '', jobId: '', stage, status: 'running', stale: false, before: '', after: null },
        packageDir: context.packageDir,
        target,
        hashes,
        rules,
        capabilities
      };
      if (!sameSnapshot(context.project, check)) throw new Error('Входные материалы изменились во время подготовки задания.');
      const job = this.options.agents.start({ project: context.project, task: `ai-clip-scene:${input.shot}:${stage}`, prompt, context: agentContext });
      check.proposal = {
        id: randomUUID(),
        jobId: job.id,
        stage,
        status: 'running',
        stale: false,
        before:
          stage === 'description'
            ? context.packageDir
              ? text(join(context.packageDir, 'description.md'))
              : ''
            : stage === 'prompt'
              ? text(join(context.packageDir!, 'video-prompt.txt'))
              : JSON.stringify(context.workflow),
        after: null
      };
      this.write(context.project, input.shot, check);
    } finally {
      this.busy.delete(key);
    }
    return this.view(context.project, input.shot, input.packageDir);
  }
  async generateFrames(project: string, shot: string, packageDir: string): Promise<ProductionWorkflowView> {
    const context = this.context(project, shot, packageDir);
    if (!this.view(context.project, shot, packageDir).canGenerateFrames) throw new Error('Сначала утвердите описание и план опор.');
    this.ensureNoPending(context);
    const hashes = snapshot(context.project, context.packageDir, packageDir, context.allowedPaths);
    // Совместимые принятые опоры остаются в пакете; отдельное image-задание готовит только недостающие.
    const frames = context.framePrompts.filter((prompt) => !context.workflow?.keyframes?.some((frame) => frame.id === prompt.id && frame.approved));
    const imageProvider = mediaProviderInfo(readProjectSettings(context.project).generation?.image?.provider, 'image');
    if (!imageProvider) throw new Error(`Выберите провайдера генерации изображений в настройках проекта: ${mediaProviderTitles('image')}.`);
    // Провайдер без исполнителя-агента готовит платный запрос на одну опору; агент создаёт недостающие опоры заданием.
    if (!imageProvider.executor) {
      if (!this.options.prepareImageRequest) throw new Error(`Исполнитель изображений ${imageProvider.title} не подключён.`);
      const missing = frames.filter(
        (prompt) =>
          !context.workflow?.keyframes?.some(
            (frame) => frame.id === prompt.id && frame.path && existsSync(productionPath(context.project, join(context.packageDir!, frame.path)))
          )
      );
      if (!missing.length) throw new Error('Кандидаты всех опор уже сохранены. Просмотрите и утвердите их.');
      const key = this.key(context.project, shot);
      this.busy.add(key);
      try {
        await this.options.prepareImageRequest({ project: context.project, shot, packageDir: context.packageDir!, frames: [missing[0]] });
      } finally {
        this.busy.delete(key);
      }
      return this.view(context.project, shot, packageDir);
    }
    const job = this.options.generateImages({ project: context.project, shot, packageDir: context.packageDir!, frames });
    this.write(context.project, shot, {
      proposal: {
        id: randomUUID(),
        jobId: job.id,
        stage: 'frames',
        status: 'running',
        stale: false,
        before: JSON.stringify(context.workflow?.keyframes ?? []),
        after: null
      },
      packageDir: context.packageDir,
      target: context.packageDir!,
      hashes,
      rules: { ...rulesFor(context, 'frames'), framePrompts: frames },
      imageJob: true
    });
    return this.view(context.project, shot, packageDir);
  }
  async importFrames(project: string, shot: string, packageDir: string, images: ProductionFrameCandidate[]): Promise<ProductionWorkflowView> {
    const context = this.context(project, shot, packageDir);
    if (!this.view(context.project, shot, packageDir).canGenerateFrames) throw new Error('Сначала утвердите описание и план опор.');
    this.ensureNoPending(context);
    const checked = checkFrameCandidates(images, context.framePrompts);
    const stored: Stored = {
      proposal: {
        id: randomUUID(),
        jobId: '',
        stage: 'frames',
        status: 'ready',
        stale: false,
        before: JSON.stringify(context.workflow?.keyframes ?? []),
        after: { schemaVersion: 1, stage: 'frames', images: checked }
      },
      packageDir: context.packageDir,
      target: context.packageDir!,
      hashes: snapshot(context.project, context.packageDir, context.packageDir!, context.allowedPaths),
      rules: rulesFor(context, 'frames'),
      imageHashes: Object.fromEntries(checked.map((image) => [image.path, requiredFileDigest(image.path)]))
    };
    this.write(context.project, shot, stored);
    return this.view(context.project, shot, packageDir);
  }
  private ensureNoPending(context: Context): void {
    const pending = this.read(context.project, context.shot);
    if (pending && ['running', 'ready'].includes(pending.proposal.status)) throw new Error('Сначала примените или отклоните текущее предложение.');
  }
  discard(project: string, shot: string, packageDir: string | undefined, id: string): ProductionWorkflowView {
    const context = this.context(project, shot, packageDir);
    const stored = this.read(context.project, shot);
    if (
      !stored ||
      stored.proposal.id !== id ||
      stored.packageDir !== context.packageDir ||
      stored.proposal.status === 'running' ||
      stored.proposal.status === 'applied'
    )
      throw new Error('Предложение недоступно для отклонения; выполняющееся задание сначала отмените.');
    stored.proposal.status = 'interrupted';
    stored.proposal.message = 'Предложение отклонено пользователем.';
    this.write(context.project, shot, stored);
    // Отклонение убирает предложение из UI, сохраняя историю самого AgentJob.
    const path = this.path(context.project, shot);
    writeProductionJson(path, { schemaVersion: 1, discarded: id });
    return this.view(context.project, shot, packageDir);
  }
  async apply(project: string, shot: string, packageDir: string | undefined, id: string): Promise<ProductionWorkflowView> {
    const view = this.view(project, shot, packageDir);
    const stored = this.read(view.project, shot);
    if (
      view.busy ||
      !stored ||
      stored.proposal.id !== id ||
      stored.packageDir !== view.packageDir ||
      stored.proposal.status !== 'ready' ||
      view.proposal?.stale ||
      !stored.proposal.after
    )
      throw new Error('Применимо только завершённое актуальное предложение.');
    const context = this.context(view.project, shot, view.packageDir ?? undefined);
    if (stored.target === context.packageDir && (context.workflow?.pending_decision || !context.managed))
      throw new Error('Сначала ответьте на текущий вопрос согласования.');
    if (stored.target !== context.packageDir && !this.options.isScenarioApproved(view.project)) throw new Error('Утверждение сценария устарело.');
    const job = stored.proposal.jobId ? this.options.agents.get(stored.proposal.jobId) : null;
    if (stored.proposal.jobId && (!job || job.status !== 'completed' || job.exitCode !== 0)) throw new Error('Нет успешного результата агента.');
    const raw = job
      ? stored.imageJob
        ? JSON.stringify({ schemaVersion: 1, stage: 'frames', images: this.options.collectImages(job) })
        : job.result
      : JSON.stringify(stored.proposal.after);
    const after = parseProductionProposal(raw, stored.rules);
    checkProductionCapabilities(after, stored.rules, stored.capabilities, context.settings);
    if (Object.entries(stored.imageHashes ?? {}).some(([path, hash]) => !existsSync(path) || cachedFileDigest(path) !== hash))
      throw new Error('Изображения предложения изменились.');
    if (!sameSnapshot(view.project, stored)) throw new Error('Предложение устарело: изменились материалы или пакет.');
    const key = this.key(view.project, shot);
    this.busy.add(key);
    try {
      await applyProductionPackage(this.options.localDir, view.project, stored.target, async () => {
        const launcher = this.options.launcher();
        const run = async (tool: string, args: string[]): Promise<void> => {
          const result = await launcher.run(view.project, tool, args);
          if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || `${tool}: код ${result.code}`);
        };
        const ask = async (stage: string): Promise<void> => run('shot_workflow', ['ask', '--dir', stored.target, '--stage', stage, '--executor', 'app']);
        if (after.stage === 'description') {
          if (stored.target !== context.packageDir)
            await run('shot_workflow', [
              'init',
              shot,
              '--dir',
              stored.target,
              '--mode',
              'shot',
              '--executor',
              'app',
              ...(context.packageDir ? ['--retry-of', context.packageDir] : [])
            ]);
          mkdirSync(stored.target, { recursive: true });
          writeFileSync(join(stored.target, 'description.md'), `${after.description}\n`);
          await run('shot_workflow', [
            'plan-keyframes',
            '--dir',
            stored.target,
            '--request-seconds',
            String(after.requestSeconds),
            ...after.keyframes.filter((frame) => frame.role === 'middle').flatMap((frame) => ['--middle', `${frame.timeSeconds}:опора ${frame.id}`])
          ]);
          writeProductionJson(join(stored.target, 'keyframe-prompts.json'), after.keyframes);
          // Исправленное описание требует нового согласования промпта и запроса; старые request-NN сохраняются.
          const workflow = json(join(stored.target, 'workflow.json'));
          if (!record(workflow)) throw new Error('Инструмент не создал workflow.json.');
          // Одинаковые роль, время, текст и референсы сохраняют принятую опору; изменённый промпт требует нового кадра.
          const frames = Array.isArray(workflow.keyframes) ? workflow.keyframes : [];
          const approved = record(workflow.approved_frames) ? workflow.approved_frames : {};
          for (const frame of frames) {
            if (!record(frame)) throw new Error('Неверная опора в workflow.');
            const next = after.keyframes.find((item) => item.id === frame.id);
            const previous = context.framePrompts.find((item) => item.id === frame.id);
            if (!isDeepStrictEqual(previous, next)) {
              frame.approved = false;
              frame.path = null;
              frame.sha256 = null;
              delete approved[String(frame.id)];
            }
          }
          workflow.approved_frames = approved;
          workflow.description_approved = false;
          workflow.prompt = { path: 'video-prompt.txt', approved: false };
          workflow.request_dir = null;
          workflow.approved_prompt_sha256 = null;
          writeProductionJson(join(stored.target, 'workflow.json'), workflow);
          await run('shot_workflow', ['set-stage', '--dir', stored.target, 'description_review']);
          await ask('description_review');
        } else if (after.stage === 'frames') {
          for (const image of after.images) await run('shot_workflow', ['propose', '--dir', stored.target, image.id, image.path]);
          await ask('keyframes_review');
        } else if (after.stage === 'prompt') {
          if (!approvedFrames(context)) throw new Error('Утверждённые опоры изменились.');
          writeFileSync(join(stored.target, 'video-prompt.txt'), after.prompt);
          const workflow = json(join(stored.target, 'workflow.json'));
          if (!record(workflow)) throw new Error('Отсутствует workflow.json.');
          workflow.prompt = { path: 'video-prompt.txt', approved: false };
          workflow.approved_prompt_sha256 = null;
          workflow.request_dir = null;
          writeProductionJson(join(stored.target, 'workflow.json'), workflow);
          await run('shot_workflow', ['set-stage', '--dir', stored.target, 'prompt_review']);
          await ask('prompt_review');
        } else {
          if (!promptApproved(context) || !approvedFrames(context)) throw new Error('Утверждение опор или промпта устарело.');
          if (context.scene.lipsync && !after.request.inputs.some((input) => input.flag === 'audio' && /\.wav$/i.test(input.path)))
            throw new Error('Для липсинка нужен подготовленный точный WAV в audio-входе. Подготовьте его штатным инструментом.');
          let number = 1;
          while (existsSync(join(stored.target, `request-${String(number).padStart(2, '0')}`))) number++;
          const requestName = `request-${String(number).padStart(2, '0')}`;
          const specPath = join(this.options.localDir, 'production-workflow', `${stored.proposal.id}-request.json`);
          writeProductionJson(specPath, {
            schema_version: 1,
            provider: context.settings.provider,
            shot,
            kind: 'video',
            ...after.request,
            prompt_file: join(stored.target, context.workflow!.prompt!.path!),
            inputs: after.request.inputs.map((input) => ({ ...input, path: productionPath(view.project, input.path) }))
          });
          if (this.options.prepareVideoRequest)
            await this.options.prepareVideoRequest({
              project: view.project,
              shot,
              requestDir: join(stored.target, requestName),
              prompt: text(join(stored.target, context.workflow!.prompt!.path!)),
              draft: after.request,
              durationConstraint: { windowSeconds: context.window, rule: context.durationRule }
            });
          else await run('kling_request', ['prepare', '--request', specPath, '--work-dir', join(stored.target, requestName)]);
          await run('shot_workflow', ['set-stage', '--dir', stored.target, 'request_choice', '--request-dir', requestName]);
          await ask('request_choice');
        }
      });
      stored.proposal.status = 'applied';
      stored.proposal.after = after;
      this.write(view.project, shot, stored);
    } finally {
      this.busy.delete(key);
    }
    return this.view(view.project, shot, stored.target);
  }
}
