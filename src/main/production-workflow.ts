import { readCast } from './cast';
/** Один план и один пакет проходят подготовку предложений; проект меняется только отдельным Apply. */
import { productionTexts } from '@shared/texts/production';
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';
import { isDeepStrictEqual } from 'node:util';
import type { AgentJob } from '@shared/agents';
import type {
  ProductionFrameCandidate,
  ProductionFramePrompt,
  ProductionImagesInput,
  ProductionPass,
  ProductionProposal,
  ProductionProposalSummary,
  ProductionRequestDraft,
  ProductionWorkflowStart,
  ProductionWorkflowView
} from '@shared/production-workflow';
import { derivedShotReason } from '@shared/production-workflow';
import type { DurationRule } from '@shared/types';
import { isMediaProvider, mediaProviderInfo, mediaProviderTitles } from '@shared/media-providers';
import { readProjectSettings } from './checks';
import type { AgentManager } from './agent-manager';
import type { PythonLauncher } from './python-launcher';
import { acceptsAudioInput, readMediaCatalog } from './media-catalog';
import { paidAdapter } from './providers';
import { readPackageSpeech } from './speech';
import { derivedShotSource } from './derived-shot';
import { providerGuide } from './provider-guides';
import { cachedFileDigest } from './animatic-freshness';
import { currentShotFingerprint } from './shot-acceptance';
import { sourceInputDigest } from './source-input-hash';
import {
  agentResponseText,
  isAgentRefusal,
  checkFrameCandidates,
  checkProductionCapabilities,
  parseProductionProposal,
  productionPath,
  record,
  type ProposalRules
} from './production-proposal';
import { applyProductionPackage, productionPackageVideoPaid, writeProductionJson } from './production-workflow-apply';

const texts = productionTexts.main.workflow;
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
  /** Платный провайдер изображений готовит один запрос опоры; отправка остаётся за общим quote/submit. */
  prepareImageRequest?: (input: ProductionImagesInput) => Promise<void>;
  prepareVideoRequest?: (input: {
    project: string;
    shot: string;
    requestDir: string;
    prompt: string;
    draft: ProductionRequestDraft;
    durationConstraint: { windowSeconds: number; rule: DurationRule; minSeconds?: number };
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
  request_dir?: string;
  description_approved?: boolean;
  image_request_dir?: string;
  image_requests?: { frame_id: string; request_dir: string; request_sha256: string }[];
  timing?: { request_seconds?: number };
  keyframes?: Frame[];
  prompt?: { path?: string; approved?: boolean; sha256?: string };
  approved_prompt_sha256?: string;
  decision?: { stage: string; verdict: string; note?: string } | null;
  pending_decision?: { stage: string; frame?: string } | null;
  keyframe_notes?: { id: number; frame: string | null; note: string; scope: 'frame' | 'following'; active: boolean }[];
  scene_sha256?: string | null;
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
  /** Подготовленный точный WAV речевого плана в пакете. */
  speech: { path: string; sourceSeconds: [number, number] } | null;
  allowedPaths: string[];
  paid: boolean;
  problems: string[];
  /** План-источник производного плана: подготовка агентом и генерация для такого плана не нужны. */
  derivedFrom: string | null;
  /** Постановка плана изменилась после подготовки пакета: продолжать его можно только после решения пользователя. */
  sceneChanged: boolean;
}
/** Причина блокировки устаревшего пакета: выход — оставить пакет, доработать описание или подготовить новый. */
const SCENE_CHANGED_REASON = texts.sceneChangedReason;
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
  if (!/^plan\/(batches|awaiting)\/[^/]+$/.test(rel(project, target))) throw new Error(texts.packageFolderRequired);
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
  if (hash === null) throw new Error(texts.fileUnreadable({ path }));
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
    if (stat.isSymbolicLink()) throw new Error(texts.packageLink({ path: local }));
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
/** Кандидат, который ждёт решения: пока он есть, следующая опора не создаётся. */
function undecidedFrame(context: Context): string | null {
  return context.workflow?.keyframes?.find((frame) => frame.path && !frame.approved)?.id ?? null;
}
/** Опоры создаются по одной в порядке плана: следующая — первая без кандидата и утверждения. */
function nextFrame(context: Context): string | null {
  if (undecidedFrame(context)) return null;
  return context.framePrompts.find((prompt) => !context.workflow?.keyframes?.some((frame) => frame.id === prompt.id && frame.approved))?.id ?? null;
}
/** Замечания к создаваемой опоре: её собственные и сквозные, кроме снятых пользователем. */
function frameNotes(context: Context, frame: string): string[] {
  return (context.workflow?.keyframe_notes ?? [])
    .filter((note) => note.active && note.note.trim() && (note.scope === 'following' || note.frame === frame))
    .map((note) => note.note.trim());
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
    framePrompts: context.framePrompts,
    lipSync: context.scene.lipsync === true ? (mediaProviderInfo(context.settings.provider, 'video')?.lipSync ?? null) : null
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
      !['running', 'ready', 'invalid', 'failed', 'cancelled', 'interrupted', 'applied'].includes(String(value.proposal.status))
    )
      return null;
    packagePath(project, value.target);
    if (value.packageDir !== null) packagePath(project, value.packageDir as string);
    return value as unknown as Stored;
  }
  private read(project: string, shot: string): Stored | null {
    try {
      return this.checkedStored(project, json(this.path(project, shot)));
    } catch {
      return null;
    }
  }
  private write(project: string, shot: string, stored: Stored): void {
    writeProductionJson(this.path(project, shot), stored);
  }
  private context(path: string, shot: string, requested?: string): Context {
    if (!/^M\d{2}(?:\.\d+)?$/.test(shot)) throw new Error(texts.shotIdRequired);
    const project = realpathSync(path);
    const scenes = json(join(project, 'plan/scenes.json'));
    if (!record(scenes) || !Array.isArray(scenes.scenes)) throw new Error(texts.sceneRegistryInvalid);
    const scene = scenes.scenes.find((scene) => record(scene) && scene.id === shot);
    if (!record(scene)) throw new Error(texts.shotMissing({ shot }));
    const fps = Number(scenes.fps);
    const window = (Number(scene.end_frame_exclusive) - Number(scene.start_frame)) / fps;
    if (!Number.isFinite(window) || window <= 0) throw new Error(texts.shotWindowInvalid);
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
      problems.push(texts.videoSettingsRequired({ providers: mediaProviderTitles('video') }));
    // Речевой план готовится только у провайдера, который синхронизирует губы с заданным звуком и принимает такую длину.
    const provider = mediaProviderInfo(settings.provider, 'video');
    if (scene.lipsync === true && provider) {
      if (!provider.lipSync) problems.push(texts.providerLipSyncUnsupported({ provider: provider.title }));
      else if (window > provider.lipSync.max)
        problems.push(texts.speechWindowTooLong({ seconds: window.toFixed(2), provider: provider.title, max: provider.lipSync.max }));
    }
    const packageDir = requested ? packagePath(project, requested) : null;
    let workflow: Workflow | null = null;
    if (packageDir) {
      const value = json(join(packageDir, 'workflow.json'));
      if (!record(value) || value.shot !== shot || typeof value.stage !== 'string') throw new Error(texts.packageMissingOrWrongShot);
      workflow = value as unknown as Workflow;
    }
    // Тот же отпечаток, что пишет shot_workflow init: пакет, подготовленный по прежней постановке, дальше не продолжается молча.
    const currentScene = workflow && workflow.stage !== 'accepted' ? currentShotFingerprint(project, shot) : null;
    const sceneChanged = !!currentScene && workflow!.scene_sha256 !== currentScene;
    const cast = readCast(project);
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
    // Точный WAV речевого плана, подготовленный в пакете, — единственный разрешённый аудиовход запроса.
    const speech = packageDir ? readPackageSpeech(packageDir) : null;
    if (speech) allowed.add(rel(project, speech.path));
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
      speech: speech ? { path: rel(project, speech.path), sourceSeconds: [speech.start, speech.end] as [number, number] } : null,
      allowedPaths: [...allowed].sort(),
      paid: packageDir ? productionPackageVideoPaid(packageDir) : false,
      problems,
      derivedFrom: derivedShotSource(project, scene),
      sceneChanged
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
      proposal.message = texts.jobInterrupted;
    } else if (job.status === 'running') return job;
    // Остановка по кнопке — решение пользователя, а не сбой агента.
    else if (job.status === 'cancelled') {
      proposal.status = 'cancelled';
      proposal.message = texts.jobCancelled;
    } else if (job.status !== 'completed' || job.exitCode !== 0) {
      proposal.status = 'failed';
      proposal.message = job.message || texts.proposalIncomplete;
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
        // Ответ агента сохраняется для показа: он часто объясняет, почему предложение не подготовлено.
        if (!stored.imageJob) {
          const answer = agentResponseText(job.result ?? '', proposal.stage);
          if (answer) proposal.agentText = answer;
          // Текст вместо JSON — штатный отказ: ошибка разбора JSON пользователю ничего не объясняет.
          if (answer && isAgentRefusal(job.result ?? '')) {
            proposal.refused = true;
            proposal.message = texts.agentRefused;
          }
        }
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
    // Производный план не готовится агентом: предложение, оставшееся до отметки derived_from, больше не показывается.
    const relevant =
      stored &&
      !(context.derivedFrom && stored.proposal.status !== 'running') &&
      (stored.proposal.status === 'applied' ? stored.target === context.packageDir : stored.packageDir === context.packageDir)
        ? stored
        : null;
    const job = this.refresh(context, relevant);
    const busy =
      this.busy.has(this.key(canonical, shot)) ||
      this.options.agents.list(canonical).some((job) => job.status === 'running') ||
      (!!context.packageDir && !!this.options.isPackageBusy?.(canonical, context.packageDir));
    const pending = !!context.workflow?.pending_decision;
    const descriptionApproved = context.workflow?.description_approved === true;
    const frameRevision = context.workflow?.decision?.stage === 'keyframes_review' && context.workflow.decision.verdict === 'revise';
    const proposalPending = !!relevant && ['running', 'ready'].includes(relevant.proposal.status);
    const enabled = !busy && !proposalPending && !context.problems.length && !pending && !context.paid;
    const imagePhase = context.workflow?.stage?.startsWith('image_');
    const imageEnabled =
      !busy && !context.problems.some((problem) => !problem.startsWith(texts.videoSettingsIncomplete)) && !pending && !context.paid && !imagePhase;
    const scenarioApproved = this.options.isScenarioApproved(canonical);
    const framesApproved = approvedFrames(context);
    const nextStage = stageFor(context);
    const common = busy ? texts.operationBusy : proposalPending ? texts.resolveProposalFirst : pending ? texts.resolvePackageQuestionFirst : null;
    // Срез должен уложиться в допустимую длину звукового входа провайдера, иначе сервис отклонит запрос.
    const lipSync = mediaProviderInfo(context.settings.provider, 'video')?.lipSync ?? null;
    const speechLength = context.speech ? context.speech.sourceSeconds[1] - context.speech.sourceSeconds[0] : null;
    const speechMismatch =
      context.scene.lipsync === true && lipSync && speechLength !== null && (speechLength < lipSync.min - 1e-6 || speechLength > lipSync.max + 1e-6)
        ? texts.speechLengthOutOfRange({ seconds: speechLength.toFixed(2), min: lipSync.min, max: lipSync.max })
        : null;
    // Производный план собирается из чужого материала: эта причина постоянна и важнее временной занятости.
    const derived = context.derivedFrom ? derivedShotReason(context.derivedFrom) : null;
    const reasons = {
      prepare:
        derived ??
        (busy ? texts.operationBusy : imagePhase ? texts.resolveImageFirst : !scenarioApproved ? texts.approveScenarioFirst : (context.problems[0] ?? null)),
      continue:
        derived ??
        (!context.packageDir
          ? texts.acceptedDescriptionAndFramesRequired
          : context.sceneChanged
            ? SCENE_CHANGED_REASON
            : (common ??
              (context.paid
                ? texts.sentAttemptNeedsRetry
                : context.problems.length
                  ? context.problems.join(' ')
                  : imagePhase
                    ? texts.resolveImageFirst
                    : nextStage === 'request' && context.scene.lipsync === true && !context.speech
                      ? texts.speechRequiredHint
                      : nextStage === 'request' && speechMismatch
                        ? speechMismatch
                        : !nextStage || nextStage === 'description'
                          ? framesApproved
                            ? texts.framesAcceptedPromptNext
                            : descriptionApproved
                              ? texts.createAndAcceptFramesFirst
                              : texts.applyAndAcceptDescriptionFirst
                          : null))),
      frames:
        derived ??
        (!context.packageDir
          ? texts.acceptedDescriptionRequired
          : context.sceneChanged
            ? SCENE_CHANGED_REASON
            : (common ??
              (context.paid
                ? texts.attemptAlreadySent
                : framesApproved
                  ? texts.framesAlreadyAccepted
                  : undecidedFrame(context)
                    ? texts.acceptFrameFirstHint({ frame: undecidedFrame(context) })
                    : !context.framePrompts.length
                      ? texts.framePlanMissing
                      : !(descriptionApproved || frameRevision)
                        ? texts.acceptDescriptionFirst
                        : imagePhase
                          ? texts.resolveImageFirst
                          : null)))
    };
    const generation = readProjectSettings(canonical).generation;
    return {
      project: canonical,
      shot,
      packageDir: context.packageDir,
      busy,
      stage: context.workflow?.stage ?? null,
      reasons,
      derivedFrom: context.derivedFrom,
      canPrepare: !derived && !busy && !imagePhase && scenarioApproved && !context.problems.length,
      canContinue:
        !derived &&
        !context.sceneChanged &&
        enabled &&
        !imagePhase &&
        !!stageFor(context) &&
        stageFor(context) !== 'description' &&
        !(stageFor(context) === 'request' && speechMismatch),
      // Пока у пакета есть вопрос, замечание вводится в его карточке; панель подхватывает сохранённый ответ «вернуть».
      canRevise: !derived && !busy && !proposalPending && !imagePhase && !!context.packageDir && !context.problems.length && !pending,
      canGenerateFrames:
        !derived &&
        !context.sceneChanged &&
        imageEnabled &&
        !!context.packageDir &&
        !approvedFrames(context) &&
        !!nextFrame(context) &&
        (descriptionApproved || frameRevision),
      paid: context.paid,
      imageProvider: generation?.image?.provider,
      videoProvider: generation?.video?.provider,
      framePrompts: context.framePrompts,
      nextFrame: nextFrame(context),
      approvedFrameIds: (context.workflow?.keyframes ?? []).filter((frame) => frame.approved).map((frame) => frame.id),
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
      throw new Error(texts.startParametersInvalid);
    const context = this.context(input.project, input.shot, input.packageDir);
    if (context.derivedFrom) throw new Error(derivedShotReason(context.derivedFrom));
    const view = this.view(context.project, input.shot, input.packageDir);
    if (context.workflow?.stage.startsWith('image_')) throw new Error(texts.currentImageUnresolved);
    if (view.busy) throw new Error(texts.waitForJob);
    const existing = this.read(context.project, input.shot);
    if (existing && ['running', 'ready'].includes(existing.proposal.status)) throw new Error(texts.resolveProposalFirstError);
    let stage: Exclude<ProductionPass, 'frames'>;
    const newPackage = input.action === 'prepare' || (context.paid && input.action === 'revise');
    if (newPackage) {
      if (!view.canPrepare) throw new Error(texts.scenarioAndSettingsRequired);
      stage = 'description';
    } else {
      if (!context.packageDir || context.paid || context.problems.length) throw new Error(context.problems.join(' ') || texts.packageUnavailable);
      if (context.workflow?.pending_decision) throw new Error(texts.resolveQuestionFirst);
      stage =
        input.stage ??
        stageFor(context) ??
        (input.action === 'revise' ? (promptApproved(context) ? 'request' : approvedFrames(context) ? 'prompt' : 'description') : null)!;
      if (!stage) throw new Error(texts.descriptionOrFramesReviewRequired);
      const appropriate = stage === 'description' ? true : stage === 'prompt' ? approvedFrames(context) : promptApproved(context);
      if (!appropriate || (input.action === 'continue' && stage !== stageFor(context))) throw new Error(texts.stageUnavailable);
      // Устаревший пакет продолжается только новым описанием: оно строится по текущей постановке.
      if (context.sceneChanged && stage !== 'description') throw new Error(texts.resolveSceneChangedPackageFirst({ reason: SCENE_CHANGED_REASON }));
    }
    const key = this.key(context.project, input.shot);
    this.busy.add(key);
    try {
      const root = this.options.toolsRoot();
      if (!root) throw new Error(texts.toolsRootMissing);
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
        if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || texts.continuityFailed);
        briefs[phase] = JSON.parse(result.stdout);
      }
      const reports: unknown[] = [];
      const discoveryProblems: string[] = [];
      // Речевому плану нужен режим со звуковым входом: агент видит все режимы провайдера уже при описании.
      const lipsync = context.scene.lipsync === true;
      try {
        const adapter = paidAdapter(context.settings.provider);
        if (!adapter) throw new Error(texts.providerCapabilitiesMissing);
        const draft = stage === 'request' || lipsync ? undefined : adapter.rules.draftVideoCommands;
        const visible = (command: string): boolean => !draft || draft.includes(command);
        // Производство использует тот же снимок, что и настройки, без отдельных запросов для каждой команды.
        const catalog = await readMediaCatalog(launcher, context.project, adapter.id, 'video');
        reports.push(...catalog.reports.filter((report) => visible(report.command)));
        discoveryProblems.push(...catalog.problems.filter((problem) => visible(problem.command)).map((problem) => `${problem.command}: ${problem.message}`));
      } catch (error) {
        discoveryProblems.push(message(error));
      }
      const capabilities: unknown = reports;
      const capabilitiesProblem = discoveryProblems.join(' ');
      if (stage === 'request' && !reports.length)
        throw new Error(texts.providerModelsFailed({ provider: mediaProviderInfo(context.settings.provider, 'video')?.title, problem: capabilitiesProblem }));
      if (lipsync) {
        if (stage === 'request' && !context.speech) throw new Error(texts.speechRequired);
        // Проверяем до запуска агента: без звукового входа точный липсинк невозможен, и агент всё равно вернул бы ошибку.
        if (reports.length && !acceptsAudioInput(reports))
          throw new Error(texts.providerAudioUnsupported({ provider: mediaProviderInfo(context.settings.provider, 'video')?.title }));
      }
      const rules = rulesFor(context, stage);
      const skill = [
        text(join(root, 'skills/ai-clip-scene/SKILL.md')),
        text(join(root, 'skills/ai-clip-scene/references/app-proposal.md')),
        text(join(root, 'skills/ai-clip-scene/references/prompt-template.md')),
        // Особенности сервисов приходят из документов провайдеров, выбранных в проекте; общий скилл их не содержит.
        providerGuide(root, 'video', context.settings.provider),
        providerGuide(root, 'image', readProjectSettings(context.project).generation?.image?.provider)
      ]
        .filter((part): part is string => !!part)
        .join('\n\n');
      const prompt =
        // eslint-disable-next-line no-restricted-syntax -- Инструкция и JSON-контракт задания агента сохраняются у владельца промпта.
        `${skill}\n\nРежим приложения: output=proposal, stage=${stage}. Верни ровно один JSON без Markdown, записей файлов, shell и вызовов инструментов. ` +
        // eslint-disable-next-line no-restricted-syntax -- Инструкция и JSON-контракт задания агента сохраняются у владельца промпта.
        'Форма: description={"schemaVersion":1,"stage":"description","description":"текст","requestSeconds":целое,"keyframes":[{"id":"K01","role":"first","timeSeconds":0,"prompt":"полный промпт изображения","referencePaths":["source/..."]},...,{"id":"KNN","role":"last","timeSeconds":requestSeconds,"prompt":"...","referencePaths":[]}]}; ' +
        // eslint-disable-next-line no-restricted-syntax -- Инструкция и JSON-контракт задания агента сохраняются у владельца промпта.
        'prompt={"schemaVersion":1,"stage":"prompt","prompt":"полный видеопромпт"}; request={"schemaVersion":1,"stage":"request","request":{"model":"точное имя из capabilities","command":"точное имя команды из capabilities","parameters":{"duration":requestSeconds,...параметры capabilities},"inputs":[{"flag":"input","slot":"слот из capabilities","path":"объявленный путь","role":"назначение файла"}],"outputs":1}}. ' +
        // eslint-disable-next-line no-restricted-syntax -- Инструкция и JSON-контракт задания агента сохраняются у владельца промпта.
        'Команду, параметры и слоты входов бери только из capabilities выбранной модели; какой слот служит первым и последним кадром, а какой референсом, — в указаниях провайдера видео. ' +
        // eslint-disable-next-line no-restricted-syntax -- Инструкция и JSON-контракт задания агента сохраняются у владельца промпта.
        'flag — input с объявленным slot либо короткий флаг из inputFlags без slot; не смешивай эти способы в одном запросе. ' +
        // eslint-disable-next-line no-restricted-syntax -- Инструкция и JSON-контракт задания агента сохраняются у владельца промпта.
        'Никаких других полей. ID опор K01,K02,... подряд, first на 0 и last на requestSeconds, middle строго между. Сохраняй утверждённую постановку, внешность и непрерывность. ' +
        // eslint-disable-next-line no-restricted-syntax -- Инструкция и JSON-контракт задания агента сохраняются у владельца промпта.
        'settings.model — необязательное предпочтение. Сначала выбери по capabilities модель, совместимую с длительностью, разрешением, пропорциями и всеми референсами задачи. ' +
        // eslint-disable-next-line no-restricted-syntax -- Инструкция и JSON-контракт задания агента сохраняются у владельца промпта.
        'Если предпочтение несовместимо, предложи другую модель и её собственные объявленные параметры; не переноси флаги другой модели и не уменьшай требования ради предпочтения. ' +
        // eslint-disable-next-line no-restricted-syntax -- Инструкция и JSON-контракт задания агента сохраняются у владельца промпта.
        'Соблюдай settings.duration_rule и выбери ближайшую поддерживаемую длительность, если capabilities доступны. Не выдумывай возможности моделей, путь WAV и цену. Для липсинка нужен готовый точный WAV: на этапе request передай speech.path входом объявленного звукового слота модели, а duration запроса выбери не меньше длины speech (sourceSeconds) и выбери модель с таким слотом (какой слот — в указаниях провайдера видео); если на этапе request speech нет, сообщи диагностическую ошибку вместо произвольной команды. На этапах description и prompt speech может ещё отсутствовать: приложение режет WAV в блоке «Речь» после описания, длиной requestSeconds от начала окна; не прерывайся из-за этого. Для речевого плана requestSeconds выбирай в пределах lipSync.min..lipSync.max (длина звука, которую принимает провайдер) и по правилу длительности; запас после окна уходит в монтаж обрезкой. Пути только из allowedPaths.';
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
        speech: context.speech,
        lipSync: rules.lipSync ?? null,
        allowedPaths: context.allowedPaths,
        windowSeconds: context.window,
        capabilities,
        capabilitiesProblem,
        // Короткие флаги входов объявляет адаптер провайдера видео.
        inputFlags: Object.keys(paidAdapter(context.settings.provider)?.rules.inputFlags ?? {}),
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
      if (!sameSnapshot(context.project, check)) throw new Error(texts.inputsChangedDuringPreparation);
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
    if (context.derivedFrom) throw new Error(derivedShotReason(context.derivedFrom));
    if (!this.view(context.project, shot, packageDir).canGenerateFrames) throw new Error(texts.descriptionAndFramePlanRequired);
    this.ensureNoPending(context);
    const hashes = snapshot(context.project, context.packageDir, packageDir, context.allowedPaths);
    // Опоры создаются по одной: задание готовит следующую по плану, а решение по ней открывает следующую.
    const target = nextFrame(context);
    const prompt = context.framePrompts.find((item) => item.id === target);
    if (!prompt) throw new Error(undecidedFrame(context) ? texts.acceptFrameFirst({ frame: undecidedFrame(context) }) : texts.allFramesCreated);
    const notes = frameNotes(context, prompt.id);
    const frames = [prompt];
    const imageProvider = mediaProviderInfo(readProjectSettings(context.project).generation?.image?.provider, 'image');
    if (!imageProvider) throw new Error(texts.imageProviderRequired({ providers: mediaProviderTitles('image') }));
    // Провайдер без исполнителя-агента готовит платный запрос на одну опору; агент создаёт недостающие опоры заданием.
    if (!imageProvider.executor) {
      if (!this.options.prepareImageRequest) throw new Error(texts.imageAdapterMissing({ provider: imageProvider.title }));
      // Замечания пользователя входят в текст замороженного запроса: его SHA и цена подтверждаются как обычно.
      // eslint-disable-next-line no-restricted-syntax -- Исправления добавляются в замороженный промпт и участвуют в SHA платного запроса.
      const framed = notes.length ? { ...prompt, prompt: `${prompt.prompt}\n\nИсправления к прежним вариантам: ${notes.join(' ')}` } : prompt;
      const key = this.key(context.project, shot);
      this.busy.add(key);
      try {
        await this.options.prepareImageRequest({ project: context.project, shot, packageDir: context.packageDir!, frames: [framed] });
      } finally {
        this.busy.delete(key);
      }
      return this.view(context.project, shot, packageDir);
    }
    // Утверждённые опоры этого пакета — референсы согласованности: внешность, одежда, свет и расстановка следующего кадра.
    const approvedFrameFiles = (context.workflow?.keyframes ?? [])
      .filter((frame) => frame.approved && frame.path)
      .map((frame) => ({ id: frame.id, role: frame.role, path: productionPath(context.project, join(context.packageDir!, frame.path!)) }));
    const job = this.options.generateImages({
      project: context.project,
      shot,
      packageDir: context.packageDir!,
      frames,
      notes,
      approvedFrames: approvedFrameFiles
    });
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
    if (context.derivedFrom) throw new Error(derivedShotReason(context.derivedFrom));
    if (!this.view(context.project, shot, packageDir).canGenerateFrames) throw new Error(texts.descriptionAndFramePlanRequired);
    this.ensureNoPending(context);
    // Свои опоры можно добавить для любых ещё не утверждённых кадров; утверждённую сначала возвращают на доработку.
    const open = context.framePrompts.filter((prompt) => !context.workflow?.keyframes?.some((frame) => frame.id === prompt.id && frame.approved));
    const checked = checkFrameCandidates(images, open);
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
    if (pending && ['running', 'ready'].includes(pending.proposal.status)) throw new Error(texts.resolveProposalFirstError);
  }
  /**
   * Непринятые предложения по планам проекта для списка «Производства». Заодно удаляются записи, которые
   * уже нельзя показать: план убран из реестра или стал производным, пакет предложения удалён.
   */
  pendingProposals(path: string): Record<string, ProductionProposalSummary> {
    let project: string;
    try {
      project = realpathSync(path);
    } catch {
      return {};
    }
    const registry = json(join(project, 'plan/scenes.json'));
    if (!record(registry) || !Array.isArray(registry.scenes)) return {};
    const scenes = registry.scenes.filter((scene): scene is Record<string, unknown> => record(scene) && typeof scene.id === 'string');
    const byFile = new Map(scenes.map((scene) => [`${digest(this.key(project, scene.id as string))}.json`, scene]));
    const folder = join(this.options.localDir, 'production-workflow');
    const result: Record<string, ProductionProposalSummary> = {};
    for (const name of existsSync(folder) ? readdirSync(folder) : []) {
      if (!name.endsWith('.json') || name.endsWith('-request.json')) continue;
      let value: unknown;
      try {
        value = json(join(folder, name));
      } catch {
        continue;
      }
      // Записи других проектов не трогаем: проект указан в правилах предложения.
      if (!record(value) || !record(value.rules) || value.rules.project !== project || !record(value.proposal)) continue;
      const scene = byFile.get(name);
      // Завершённое задание переводит предложение в итоговый статус только при чтении вида плана: обновляем его здесь,
      // иначе ответ агента по плану, на который пользователь не возвращался, не попадёт в «Ждут вашего действия».
      if (scene && value.proposal.status === 'running') {
        try {
          this.view(project, scene.id as string, typeof value.packageDir === 'string' ? value.packageDir : undefined);
          value = json(join(folder, name));
        } catch {
          // Вид плана недоступен (например, реестр повреждён): запись остаётся как есть.
        }
        if (!record(value) || !record(value.proposal)) continue;
      }
      const status = String(value.proposal.status);
      const packageDir = typeof value.packageDir === 'string' ? value.packageDir : null;
      const target = typeof value.target === 'string' ? value.target : null;
      const orphan =
        !scene ||
        !!derivedShotSource(project, scene) ||
        (packageDir !== null && !existsSync(packageDir)) ||
        (status === 'applied' && (!target || !existsSync(target)));
      if (orphan) {
        if (status !== 'running') rmSync(join(folder, name), { force: true });
        continue;
      }
      if (status === 'ready' || status === 'invalid' || status === 'failed')
        result[scene.id as string] = {
          stage: value.proposal.stage as ProductionProposalSummary['stage'],
          status,
          stale: value.proposal.stale === true,
          packageDir
        };
    }
    return result;
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
      throw new Error(texts.discardUnavailable);
    stored.proposal.status = 'interrupted';
    stored.proposal.message = texts.proposalDiscarded;
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
      throw new Error(texts.applyUnavailable);
    const context = this.context(view.project, shot, view.packageDir ?? undefined);
    if (stored.target === context.packageDir && context.workflow?.pending_decision) throw new Error(texts.resolveQuestionFirst);
    if (stored.target !== context.packageDir && !this.options.isScenarioApproved(view.project)) throw new Error(texts.scenarioApprovalStale);
    const job = stored.proposal.jobId ? this.options.agents.get(stored.proposal.jobId) : null;
    if (stored.proposal.jobId && (!job || job.status !== 'completed' || job.exitCode !== 0)) throw new Error(texts.agentResultMissing);
    const raw = job
      ? stored.imageJob
        ? JSON.stringify({ schemaVersion: 1, stage: 'frames', images: this.options.collectImages(job) })
        : job.result
      : JSON.stringify(stored.proposal.after);
    const after = parseProductionProposal(raw, stored.rules);
    checkProductionCapabilities(after, stored.rules, stored.capabilities, context.settings);
    if (Object.entries(stored.imageHashes ?? {}).some(([path, hash]) => !existsSync(path) || cachedFileDigest(path) !== hash))
      throw new Error(texts.proposalImagesChanged);
    if (!sameSnapshot(view.project, stored)) throw new Error(texts.proposalStale);
    const key = this.key(view.project, shot);
    this.busy.add(key);
    try {
      await applyProductionPackage(this.options.localDir, view.project, stored.target, async () => {
        const launcher = this.options.launcher();
        const run = async (tool: string, args: string[]): Promise<void> => {
          const result = await launcher.run(view.project, tool, args);
          if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || texts.toolExitCode({ tool, code: result.code }));
        };
        const ask = async (stage: string): Promise<void> => run('shot_workflow', ['ask', '--dir', stored.target, '--stage', stage]);
        if (after.stage === 'description') {
          if (stored.target !== context.packageDir)
            await run('shot_workflow', [
              'init',
              shot,
              '--dir',
              stored.target,
              '--mode',
              'shot',
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
            // eslint-disable-next-line no-restricted-syntax -- Подпись опоры входит в данные аргумента --middle штатного инструмента.
            ...after.keyframes.filter((frame) => frame.role === 'middle').flatMap((frame) => ['--middle', `${frame.timeSeconds}:опора ${frame.id}`])
          ]);
          writeProductionJson(join(stored.target, 'keyframe-prompts.json'), after.keyframes);
          // Исправленное описание требует нового согласования промпта и запроса; старые request-NN сохраняются.
          const workflow = json(join(stored.target, 'workflow.json'));
          if (!record(workflow)) throw new Error(texts.workflowNotCreated);
          // Одинаковые роль, время, текст и референсы сохраняют принятую опору; изменённый промпт требует нового кадра.
          const frames = Array.isArray(workflow.keyframes) ? workflow.keyframes : [];
          const approved = record(workflow.approved_frames) ? workflow.approved_frames : {};
          for (const frame of frames) {
            if (!record(frame)) throw new Error(texts.workflowFrameInvalid);
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
          // Новое описание построено по текущей постановке: пакет снова соответствует сценарию.
          const currentScene = currentShotFingerprint(view.project, shot);
          if (currentScene) workflow.scene_sha256 = currentScene;
          workflow.prompt = { path: 'video-prompt.txt', approved: false };
          workflow.request_dir = null;
          workflow.approved_prompt_sha256 = null;
          writeProductionJson(join(stored.target, 'workflow.json'), workflow);
          await run('shot_workflow', ['set-stage', '--dir', stored.target, 'description_review']);
          await ask('description_review');
        } else if (after.stage === 'frames') {
          for (const image of after.images) await run('shot_workflow', ['propose', '--dir', stored.target, image.id, image.path]);
          // Вопрос задаётся о первом в плане неутверждённом кандидате; остальные получат свой после решения по нему.
          const proposed = json(join(stored.target, 'workflow.json'));
          const keyframes = record(proposed) && Array.isArray(proposed.keyframes) ? (proposed.keyframes as Frame[]) : [];
          const first = keyframes.find((frame) => frame.path && !frame.approved);
          if (first) await run('shot_workflow', ['ask', '--dir', stored.target, '--stage', 'keyframes_review', '--frame', first.id]);
        } else if (after.stage === 'prompt') {
          if (!approvedFrames(context)) throw new Error(texts.acceptedFramesChanged);
          writeFileSync(join(stored.target, 'video-prompt.txt'), after.prompt);
          const workflow = json(join(stored.target, 'workflow.json'));
          if (!record(workflow)) throw new Error(texts.workflowMissing);
          workflow.prompt = { path: 'video-prompt.txt', approved: false };
          workflow.approved_prompt_sha256 = null;
          workflow.request_dir = null;
          writeProductionJson(join(stored.target, 'workflow.json'), workflow);
          await run('shot_workflow', ['set-stage', '--dir', stored.target, 'prompt_review']);
          await ask('prompt_review');
        } else {
          if (!promptApproved(context) || !approvedFrames(context)) throw new Error(texts.frameOrPromptApprovalStale);
          // Звуковой вход — именно подготовленный WAV пакета: отдельным флагом audio или именованным слотом audio_N.
          const speechInput = (input: { flag: string; slot?: string; path: string }): boolean =>
            (input.flag === 'audio' || (input.flag === 'input' && /^audio/i.test(input.slot ?? ''))) && input.path === context.speech?.path;
          if (context.scene.lipsync && !after.request.inputs.some(speechInput)) throw new Error(texts.speechInputRequired);
          // Видео короче среза оборвало бы речь: длительность запроса покрывает весь WAV.
          const speechLength = context.speech ? context.speech.sourceSeconds[1] - context.speech.sourceSeconds[0] : 0;
          if (context.scene.lipsync && Number(after.request.parameters?.duration) < speechLength - 1e-6)
            throw new Error(texts.requestShorterThanSpeech({ seconds: speechLength.toFixed(2) }));
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
              durationConstraint: {
                windowSeconds: context.window,
                rule: context.durationRule,
                ...(stored.rules.lipSync ? { minSeconds: stored.rules.lipSync.min } : {})
              }
            });
          else await run('media_request', ['prepare', '--request', specPath, '--work-dir', join(stored.target, requestName)]);
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
