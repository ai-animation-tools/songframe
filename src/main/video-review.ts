import { readCast } from './cast';
/** Проверка оригинала по неподвижным кадрам: решение о приёмке остаётся в Production.accept.
 * @link ../../skills/ai-clip-video-review/SKILL.md */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, readFileSync, realpathSync } from 'node:fs';
import { isAbsolute, join, relative, sep } from 'node:path';
import type { AgentManager } from './agent-manager';
import type { PythonLauncher } from './python-launcher';
import type { PackageView, SceneShot } from '@shared/types';
import type { VideoReviewFinding, VideoReviewFrame, VideoReviewReport, VideoReviewView } from '@shared/video-review';
import { videoReviewTexts } from '@shared/texts/video-review';
import { record, productionPath } from './production-proposal';
import { readPackage } from './production';
import { currentShotFingerprint } from './shot-acceptance';
import { cachedFileDigest } from './animatic-freshness';
import { readScenarioRegistry } from './scenario-status';
import { writeProductionJson } from './production-workflow-apply';

const texts = videoReviewTexts.main;
const REVIEW = 'video-review';
interface Options {
  agents: Pick<AgentManager, 'start' | 'get' | 'list' | 'cancel'>;
  launcher: () => Pick<PythonLauncher, 'run' | 'available'>;
  toolsRoot: () => string | null;
  isPackageBusy: (project: string, packageDir: string) => boolean;
  /** Бюджет локальных изображений выбранного CLI с запасом для его транспорта. */
  imageBudgetBytes?: () => number;
}
interface Stored {
  schemaVersion: 1;
  id: string;
  shot: string;
  sourceHash: string;
  status: VideoReviewView['status'];
  durationSeconds: number | null;
  frames: VideoReviewFrame[];
  /** Все пути в снимке относительны пакету: перенос папки не требует исправления отчёта. */
  imageHashes: Record<string, string>;
  jobId: string | null;
  report: VideoReviewReport | null;
  error: string | null;
}
interface Context {
  project: string;
  directory: string;
  pkg: PackageView;
  scene: SceneShot;
  video: string;
  references: NonNullable<PackageView['keyframes'][number]['imagePath']>[];
  sourceHash: string;
  staging: unknown;
}
const digest = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const nonempty = (value: unknown, max = 4000): value is string => typeof value === 'string' && !!value.trim() && value.length <= max;
const statuses = ['idle', 'preparing', 'running', 'completed', 'failed', 'cancelled'];
function exactKeys(value: Record<string, unknown>, expected: string[]): boolean {
  return Object.keys(value).every((key) => expected.includes(key));
}

/** Таймкод должен совпасть с одним из кадров-свидетельств: модель не может придумать непросмотренный момент. */
export function parseVideoReviewReport(value: unknown, frames: VideoReviewFrame[], duration: number): VideoReviewReport {
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value);
    } catch {
      throw new Error(texts.invalidReport);
    }
  }
  if (
    !record(value) ||
    !exactKeys(value, ['schemaVersion', 'summary', 'findings', 'limitations']) ||
    value.schemaVersion !== 1 ||
    !nonempty(value.summary) ||
    !Array.isArray(value.findings) ||
    !value.findings.length ||
    value.findings.length > 40 ||
    !Array.isArray(value.limitations) ||
    !value.limitations.length ||
    value.limitations.length > 20 ||
    !value.limitations.every((item) => nonempty(item, 1000))
  )
    throw new Error(texts.invalidReport);
  const byId = new Map(frames.map((frame) => [frame.id, frame]));
  const findings: VideoReviewFinding[] = value.findings.map((item: unknown) => {
    if (
      !record(item) ||
      !exactKeys(item, ['verdict', 'timeSeconds', 'description', 'frameIds']) ||
      !['match', 'mismatch', 'uncertain'].includes(String(item.verdict)) ||
      !nonempty(item.description, 2000) ||
      typeof item.timeSeconds !== 'number' ||
      !Number.isFinite(item.timeSeconds) ||
      item.timeSeconds < 0 ||
      item.timeSeconds >= duration ||
      !Array.isArray(item.frameIds) ||
      !item.frameIds.length ||
      item.frameIds.length > 8 ||
      !item.frameIds.every((id) => typeof id === 'string' && byId.has(id)) ||
      new Set(item.frameIds).size !== item.frameIds.length ||
      !item.frameIds.some((id: string) => Math.abs(byId.get(id)!.timeSeconds - (item.timeSeconds as number)) <= 0.001)
    )
      throw new Error(texts.invalidReport);
    return {
      verdict: item.verdict as VideoReviewFinding['verdict'],
      timeSeconds: item.timeSeconds,
      description: item.description,
      frameIds: item.frameIds as string[]
    };
  });
  return { schemaVersion: 1, summary: value.summary, findings, limitations: value.limitations as string[] };
}

export class VideoReview {
  private readonly preparing = new Map<string, { controller: AbortController; completion: Promise<void> }>();
  constructor(private readonly options: Options) {}

  private directory(project: string, packageDir: string): { project: string; directory: string } {
    if (typeof project !== 'string' || !isAbsolute(project) || typeof packageDir !== 'string') throw new Error(texts.invalidPackage);
    const root = realpathSync(project);
    const directory = productionPath(root, packageDir);
    const local = relative(root, directory).split(sep).join('/');
    if (!/^plan\/(batches|awaiting)\/[^/]+$/.test(local) || !existsSync(join(directory, 'workflow.json'))) throw new Error(texts.invalidPackage);
    return { project: root, directory };
  }
  private source(project: string, directory: string): Context {
    const pkg = readPackage(project, directory);
    const registry = readScenarioRegistry(project).registry;
    const scene = registry?.scenes.find((scene) => scene.id === pkg?.shot);
    if (
      !pkg ||
      !scene ||
      pkg.request?.kind === 'image' ||
      !['downloaded', 'edit_review', 'accepted'].includes(pkg.stage) ||
      !pkg.resultToken ||
      !pkg.request?.downloads.length ||
      pkg.request.downloads.length !== 1
    )
      throw new Error(texts.videoRequired);
    const video = productionPath(project, pkg.request.downloads[0]);
    const references = pkg.keyframes.filter((frame) => frame.approved && frame.imagePath).map((frame) => productionPath(project, frame.imagePath!));
    if (!references.length || references.length > 20) throw new Error(texts.referencesRequired);
    const files = [video, ...references].map((path) => ({ path: relative(project, path).split(sep).join('/'), sha256: cachedFileDigest(path) }));
    const fingerprint = currentShotFingerprint(project, scene.id);
    if (!fingerprint || files.some((file) => !file.sha256)) throw new Error(texts.sourceChanged);
    const cast = readCast(project);
    if (!cast) throw new Error(texts.sourceChanged);
    const staging = {
      scene,
      sequence: registry!.sequences.find((sequence) => sequence.id === scene.sequence),
      windowSeconds: (scene.end_frame_exclusive - scene.start_frame) / registry!.fps,
      requestSeconds: pkg.timing?.request_seconds,
      visualDirection: registry!.visual_direction,
      cast,
      description: pkg.description,
      videoPrompt: pkg.request.promptText ?? pkg.prompt?.text ?? '',
      keyframes: pkg.keyframes.filter((frame) => frame.approved).map((frame) => ({ id: frame.id, role: frame.role, timeSeconds: frame.time_seconds }))
    };
    return { project, directory, pkg, scene, video, references, staging, sourceHash: digest({ fingerprint, staging, files }) };
  }
  private filename(directory: string): string {
    return productionPath(directory, join(REVIEW, 'latest.json'));
  }
  private save(directory: string, stored: Stored): void {
    writeProductionJson(this.filename(directory), stored);
  }
  private read(directory: string): Stored | null {
    const file = this.filename(directory);
    if (!existsSync(file)) return null;
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(file, 'utf-8'));
    } catch {
      throw new Error(texts.invalidReport);
    }
    if (
      !record(value) ||
      value.schemaVersion !== 1 ||
      !nonempty(value.id, 80) ||
      !/^[\w-]+$/.test(value.id) ||
      !nonempty(value.shot, 20) ||
      typeof value.sourceHash !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.sourceHash) ||
      !statuses.includes(String(value.status)) ||
      !(value.durationSeconds === null || (typeof value.durationSeconds === 'number' && Number.isFinite(value.durationSeconds) && value.durationSeconds > 0)) ||
      !(value.jobId === null || nonempty(value.jobId, 128)) ||
      !(value.error === null || nonempty(value.error, 16000)) ||
      !Array.isArray(value.frames) ||
      value.frames.length > 32 ||
      !record(value.imageHashes)
    )
      throw new Error(texts.invalidReport);
    const ids = new Set<string>();
    let previousTime = -1;
    for (const frame of value.frames) {
      if (
        !record(frame) ||
        typeof frame.id !== 'string' ||
        !/^F\d{3}$/.test(frame.id) ||
        ids.has(frame.id) ||
        typeof frame.timeSeconds !== 'number' ||
        !Number.isFinite(frame.timeSeconds) ||
        frame.timeSeconds < 0 ||
        frame.timeSeconds <= previousTime ||
        value.durationSeconds === null ||
        frame.timeSeconds >= Number(value.durationSeconds) ||
        !nonempty(frame.path) ||
        isAbsolute(frame.path)
      )
        throw new Error(texts.invalidReport);
      productionPath(directory, frame.path);
      if (!frame.path.split(sep).join('/').startsWith(`${REVIEW}/${value.id}/`)) throw new Error(texts.invalidReport);
      if (typeof value.imageHashes[frame.path] !== 'string') throw new Error(texts.invalidReport);
      previousTime = frame.timeSeconds;
      ids.add(frame.id);
    }
    if (['running', 'completed'].includes(String(value.status)) && (!value.frames.length || !value.jobId || !value.durationSeconds))
      throw new Error(texts.invalidReport);
    if (value.status === 'completed' && value.report === null) throw new Error(texts.invalidReport);
    for (const [path, hash] of Object.entries(value.imageHashes)) {
      if (isAbsolute(path) || !path.split(sep).join('/').startsWith(`${REVIEW}/${value.id}/`) || typeof hash !== 'string' || !/^[a-f0-9]{64}$/.test(hash))
        throw new Error(texts.invalidReport);
      productionPath(directory, path);
    }
    if (value.report !== null) parseVideoReviewReport(value.report, value.frames as unknown as VideoReviewFrame[], Number(value.durationSeconds));
    return value as unknown as Stored;
  }
  view(project: string, packageDir: string): VideoReviewView {
    const { project: root, directory } = this.directory(project, packageDir);
    let source: Context | null = null;
    let reason: string | null = null;
    try {
      source = this.source(root, directory);
    } catch (error) {
      reason = String(error instanceof Error ? error.message : error);
    }
    if (!reason && (!this.options.toolsRoot() || !this.options.launcher().available())) reason = texts.toolsMissing;
    const busy =
      [...this.preparing.keys()].some((path) => path.startsWith(root + sep)) ||
      this.options.isPackageBusy(root, directory) ||
      this.options.agents.list(root).some((job) => job.status === 'running');
    let stored: Stored | null;
    try {
      stored = this.read(directory);
    } catch {
      return {
        status: 'failed',
        job: null,
        report: null,
        frames: [],
        stale: true,
        canStart: !reason && !busy,
        reason: reason ?? (busy ? texts.busy : null),
        error: texts.invalidReport,
        durationSeconds: null
      };
    }
    if (!stored)
      return {
        status: 'idle',
        job: null,
        report: null,
        frames: [],
        stale: false,
        canStart: !reason && !busy,
        reason: reason ?? (busy ? texts.busy : null),
        error: null,
        durationSeconds: null
      };
    const job = stored.jobId ? this.options.agents.get(stored.jobId) : null;
    if (stored.status === 'preparing' && !this.preparing.has(directory)) {
      stored.status = 'failed';
      stored.error = texts.interrupted;
      this.save(directory, stored);
    }
    if (stored.status === 'running' && job?.status !== 'running') {
      if (job?.status === 'completed') {
        try {
          stored.report = parseVideoReviewReport(job.result, stored.frames, stored.durationSeconds!);
          stored.status = 'completed';
        } catch {
          stored.status = 'failed';
          stored.error = texts.invalidReport;
        }
      } else {
        stored.status = job?.status === 'cancelled' ? 'cancelled' : 'failed';
        stored.error = job?.message || texts.interrupted;
      }
      this.save(directory, stored);
    }
    const stale =
      !source ||
      source.sourceHash !== stored.sourceHash ||
      Object.entries(stored.imageHashes).some(([path, hash]) => cachedFileDigest(productionPath(directory, path)) !== hash);
    const active = stored.status === 'running' || stored.status === 'preparing';
    return {
      status: stored.status,
      job,
      report: stored.report,
      frames: stored.frames.map((frame) => ({ ...frame, path: productionPath(directory, frame.path) })),
      stale,
      canStart: !active && !reason && !busy,
      reason: reason ?? (active || busy ? texts.busy : null),
      error: stored.error,
      durationSeconds: stored.durationSeconds
    };
  }
  async start(project: string, packageDir: string): Promise<VideoReviewView> {
    const { project: root, directory } = this.directory(project, packageDir);
    const view = this.view(root, directory);
    if (!view.canStart || [...this.preparing.keys()].some((path) => path.startsWith(root + sep))) throw new Error(view.reason || texts.busy);
    const context = this.source(root, directory);
    const stored: Stored = {
      schemaVersion: 1,
      id: randomUUID(),
      shot: context.scene.id,
      sourceHash: context.sourceHash,
      status: 'preparing',
      durationSeconds: null,
      frames: [],
      imageHashes: {},
      jobId: null,
      report: null,
      error: null
    };
    this.save(directory, stored);
    const controller = new AbortController();
    // Микрозадача запускается после резервирования: повторный клик не извлекает второй комплект кадров.
    const completion = Promise.resolve()
      .then(() => this.prepare(context, stored, controller.signal))
      .catch((error: unknown) => {
        stored.status = controller.signal.aborted ? 'cancelled' : 'failed';
        stored.error = controller.signal.aborted ? texts.cancelled : error instanceof Error ? error.message : texts.preparationFailed;
        if (existsSync(directory)) this.save(directory, stored);
      })
      .finally(() => this.preparing.delete(directory));
    this.preparing.set(directory, { controller, completion });
    return this.view(root, directory);
  }
  private async prepare(context: Context, stored: Stored, signal: AbortSignal): Promise<void> {
    const { project, directory } = context;
    const launcher = this.options.launcher();
    const out = productionPath(directory, join(REVIEW, stored.id));
    const result = await launcher.run(
      project,
      'video_review',
      [
        '--video',
        context.video,
        '--out',
        out,
        '--json',
        '--image-budget-bytes',
        String(this.options.imageBudgetBytes?.() ?? 16 * 1024 * 1024),
        ...context.references.flatMap((path) => ['--reference', path])
      ],
      { signal }
    );
    if (signal.aborted) throw new Error(texts.cancelled);
    if (result.code !== 0) throw new Error(result.stderr.trim() || texts.preparationFailed);
    const raw: unknown = JSON.parse(result.stdout);
    if (
      !record(raw) ||
      raw.schema_version !== 1 ||
      typeof raw.duration_seconds !== 'number' ||
      !Number.isFinite(raw.duration_seconds) ||
      raw.duration_seconds <= 0 ||
      !Array.isArray(raw.frames) ||
      !raw.frames.length ||
      raw.frames.length > 32 ||
      !Array.isArray(raw.references) ||
      raw.references.length !== context.references.length
    )
      throw new Error(texts.invalidFrames);
    const duration = raw.duration_seconds;
    const ids = new Set<string>();
    const images: string[] = [];
    let previousTime = -1;
    const image = (path: unknown): string => {
      if (typeof path !== 'string') throw new Error(texts.invalidFrames);
      const absolute = productionPath(out, path);
      const hash = cachedFileDigest(absolute);
      if (!hash) throw new Error(texts.invalidFrames);
      stored.imageHashes[relative(directory, absolute).split(sep).join('/')] = hash;
      images.push(absolute);
      return absolute;
    };
    stored.frames = raw.frames.map((frame: unknown) => {
      if (
        !record(frame) ||
        typeof frame.id !== 'string' ||
        !/^F\d{3}$/.test(frame.id) ||
        ids.has(frame.id) ||
        typeof frame.time_seconds !== 'number' ||
        !Number.isFinite(frame.time_seconds) ||
        frame.time_seconds < 0 ||
        frame.time_seconds <= previousTime ||
        frame.time_seconds >= duration
      )
        throw new Error(texts.invalidFrames);
      previousTime = frame.time_seconds;
      ids.add(frame.id);
      return { id: frame.id, timeSeconds: frame.time_seconds, path: relative(directory, image(frame.path)).split(sep).join('/') };
    });
    const references = raw.references.map((ref: unknown, index: number) => {
      if (!record(ref) || ref.id !== `R${String(index + 1).padStart(3, '0')}` || ref.source_path !== context.references[index])
        throw new Error(texts.invalidFrames);
      image(ref.path);
      const frame = context.pkg.keyframes.filter((frame) => frame.approved && frame.imagePath)[index];
      return { id: ref.id, keyframeId: frame.id, role: frame.role, timeSeconds: frame.time_seconds };
    });
    stored.durationSeconds = raw.duration_seconds;
    const briefs: Record<string, unknown> = {};
    for (const phase of ['before', 'after']) {
      const result = await launcher.run(project, 'continuity_brief', [context.scene.id, '--phase', phase, '--json'], { signal });
      if (signal.aborted) throw new Error(texts.cancelled);
      if (result.code !== 0) throw new Error(result.stderr.trim() || texts.preparationFailed);
      briefs[phase] = JSON.parse(result.stdout);
    }
    if (this.source(project, directory).sourceHash !== stored.sourceHash) throw new Error(texts.sourceChanged);
    const root = this.options.toolsRoot();
    if (!root) throw new Error(texts.toolsMissing);
    const skillPath = join(root, 'skills/ai-clip-video-review/SKILL.md');
    if (!existsSync(skillPath)) throw new Error(texts.instructionMissing);
    const prompt = readFileSync(skillPath, 'utf-8');
    if (!prompt.trim()) throw new Error(texts.instructionMissing);
    const job = this.options.agents.start({
      project,
      task: videoReviewTexts.heading,
      prompt,
      images,
      context: JSON.stringify({
        staging: context.staging,
        briefs,
        durationSeconds: stored.durationSeconds,
        frames: stored.frames.map(({ id, timeSeconds }) => ({ id, timeSeconds })),
        references
      })
    });
    stored.jobId = job.id;
    stored.status = 'running';
    this.save(directory, stored);
  }
  async cancel(project: string, packageDir: string): Promise<VideoReviewView> {
    const { project: root, directory } = this.directory(project, packageDir);
    const stored = this.read(directory);
    this.preparing.get(directory)?.controller.abort();
    if (stored?.jobId && this.options.agents.get(stored.jobId)?.status === 'running') this.options.agents.cancel(stored.jobId);
    if (stored && ['preparing', 'running'].includes(stored.status)) {
      stored.status = 'cancelled';
      stored.error = texts.cancelled;
      this.save(directory, stored);
    }
    return this.view(root, directory);
  }
  async shutdown(): Promise<void> {
    for (const pending of this.preparing.values()) pending.controller.abort();
    await Promise.allSettled([...this.preparing.values()].map((pending) => pending.completion));
  }
}
