/** Обложка живёт во временной сессии; только общая форма переносит принятый PNG в проект. */
import { sourcesTexts } from '@shared/texts/sources';
import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { isAbsolute, join, relative, resolve } from 'node:path';
import type { CoverCrop, CoverGenerationApproval, CoverGenerationSession } from '@shared/cover-generation';
import { isMediaProvider, MEDIA_PROVIDERS, mediaProviderTitles } from '@shared/media-providers';
import { priceAllowsGeneration } from '@shared/generation-consent';
import type { AgentManager } from './agent-manager';
import { readProjectSettings } from './checks';
import { imageExtensionMatches, isImageFile } from './keyframe-images';
import type { SettingsStore } from './settings';
import { assertAiSelection } from './ai-access';

/** Часть менеджера заданий, нужная исполнителю обложки провайдера-агента. */
export type CoverManager = Pick<AgentManager, 'startImages' | 'get' | 'onEvent' | 'shutdownAndWait'>;
export interface CoverCandidateInput {
  workDir: string;
  project: string;
  prompt: string;
  signal: AbortSignal;
}
export type PreparedCoverCandidateInput = CoverCandidateInput;
export interface PreparedCoverCandidate {
  provider: CoverGenerationSession['provider'];
  model: string | null;
  requestSha: string;
  quote: CoverGenerationSession['quote'];
  generate(signal: AbortSignal, approval?: { allowUnknownCost?: boolean }): Promise<{ path: string }>;
}
export type CoverCandidateRunner = (input: CoverCandidateInput) => Promise<{ path: string }>;
export interface CoverGenerationOptions {
  settings: SettingsStore;
  readImage(path: string): { width: number; height: number } | null;
  cropImage(input: string, output: string, crop: CoverCrop): void;
  /** Подготовка запроса провайдером изображений проекта (prepareProjectCover). */
  prepareCandidate: (input: PreparedCoverCandidateInput) => Promise<PreparedCoverCandidate>;
}
interface Record {
  session: CoverGenerationSession;
  project: string;
  root: string;
  closed: boolean;
  controller?: AbortController;
  task?: Promise<void>;
  prepared?: { candidate: PreparedCoverCandidate; workDir: string };
}

export class CoverGeneration {
  private readonly sessions = new Map<string, Record>();
  private stopping = false;
  constructor(private readonly options: CoverGenerationOptions) {}

  create(project: string, prompt: string): CoverGenerationSession {
    if (this.stopping) throw new Error(sourcesTexts.main.applicationStopping);
    if (typeof project !== 'string' || !isAbsolute(project) || project.includes('\0')) throw new Error(sourcesTexts.main.projectRequired);
    let canonical: string;
    try {
      canonical = realpathSync(project);
    } catch {
      throw new Error(sourcesTexts.main.projectMissing);
    }
    if (!existsSync(join(canonical, 'plan/project.json'))) throw new Error(sourcesTexts.main.projectPlanMissing);
    const imageSettings = readProjectSettings(canonical).generation?.image;
    if (!isMediaProvider(imageSettings?.provider, 'image')) throw new Error(sourcesTexts.main.imageProviderRequired({ titles: mediaProviderTitles('image') }));
    assertAiSelection(this.options.settings, canonical, 'image');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0') || Buffer.byteLength(prompt) > 32 * 1024)
      throw new Error(sourcesTexts.main.coverPromptInvalid);
    const id = randomUUID();
    const root = realpathSync(mkdtempSync(join(tmpdir(), 'songframe-cover-')));
    const session: CoverGenerationSession = {
      id,
      prompt,
      status: 'idle',
      image: null,
      error: null,
      provider: imageSettings.provider,
      model: imageSettings.model?.trim() || null,
      preparing: false,
      requestSha: null,
      approvalToken: null,
      quote: null
    };
    this.sessions.set(id, { session, project: canonical, root, closed: false });
    return structuredClone(session);
  }

  async prepare(id: string): Promise<CoverGenerationSession> {
    const record = this.record(id);
    assertAiSelection(this.options.settings, record.project, 'image');
    if (record.session.preparing || record.session.status === 'generating') throw new Error(sourcesTexts.main.coverBusy);
    if (record.session.status === 'accepted') throw new Error(sourcesTexts.main.coverAlreadyAccepted);
    if (record.prepared) rmSync(record.prepared.workDir, { recursive: true, force: true });
    record.prepared = undefined;
    record.session.preparing = true;
    record.session.requestSha = null;
    record.session.approvalToken = null;
    record.session.quote = null;
    record.session.error = null;
    record.controller = new AbortController();
    const workDir = join(record.root, 'image-jobs', randomUUID());
    record.task = (async () => {
      try {
        mkdirSync(workDir, { recursive: true });
        const candidate = await this.options.prepareCandidate({
          workDir,
          project: record.project,
          prompt: record.session.prompt,
          signal: record.controller!.signal
        });
        if (record.closed) return;
        if (!candidate.requestSha || !isMediaProvider(candidate.provider, 'image')) throw new Error(sourcesTexts.main.coverRequestPrepareFailed);
        record.prepared = { candidate, workDir };
        record.session.provider = candidate.provider;
        record.session.model = candidate.model;
        record.session.requestSha = candidate.requestSha;
        record.session.approvalToken = randomUUID();
        record.session.quote = candidate.quote;
      } catch (error) {
        if (record.closed) return;
        rmSync(workDir, { recursive: true, force: true });
        record.session.status = record.session.image ? 'ready' : 'failed';
        record.session.error = error instanceof Error ? error.message : sourcesTexts.main.coverPrepareFailed;
      } finally {
        record.session.preparing = false;
      }
    })();
    await record.task;
    return this.view(id);
  }

  generate(id: string, requestSha: string, approval: CoverGenerationApproval): CoverGenerationSession {
    const record = this.record(id);
    assertAiSelection(this.options.settings, record.project, 'image');
    if (record.session.preparing || record.session.status === 'generating') throw new Error(sourcesTexts.main.coverBusy);
    if (record.session.status === 'accepted') throw new Error(sourcesTexts.main.coverAcceptedNeedsNewSession);
    const prepared = record.prepared;
    if (!prepared || !requestSha || prepared.candidate.requestSha !== requestSha) throw new Error(sourcesTexts.main.coverRequestRequired);
    // Согласие относится к показанному промпту и этой подготовке, даже когда SHA следующей попытки совпадает.
    if (approval?.promptConfirmed !== true || !record.session.approvalToken || approval.approvalToken !== record.session.approvalToken)
      throw new Error(sourcesTexts.main.coverPromptConfirmationRequired);
    if (readProjectSettings(record.project).generation?.image?.provider !== prepared.candidate.provider)
      throw new Error(sourcesTexts.main.coverProviderChanged);
    const provider = MEDIA_PROVIDERS[prepared.candidate.provider];
    if (provider.paid && !priceAllowsGeneration(prepared.candidate.quote, approval.allowUnknownCost === true))
      throw new Error(sourcesTexts.main.coverCostBlocked({ title: provider.title }));
    record.prepared = undefined;
    record.session.approvalToken = null;
    // Согласованный запрос расходуется один раз; старый кандидат удаляется только после явного запуска.
    for (const name of readdirSync(record.root)) if (name !== 'image-jobs') rmSync(join(record.root, name), { recursive: true, force: true });
    for (const name of readdirSync(join(record.root, 'image-jobs'))) {
      const path = join(record.root, 'image-jobs', name);
      if (path !== prepared.workDir) rmSync(path, { recursive: true, force: true });
    }
    record.session.status = 'generating';
    record.session.image = null;
    record.session.error = null;
    record.session.requestSha = null;
    record.controller = new AbortController();
    // Отложенный запуск позволяет немедленно закрыть диалог, не создавая процесс после отмены.
    const generationApproval = { allowUnknownCost: approval.allowUnknownCost === true };
    record.task = Promise.resolve().then(() => this.run(record, prepared, generationApproval));
    return structuredClone(record.session);
  }

  view(id: string): CoverGenerationSession {
    return structuredClone(this.record(id).session);
  }

  accept(id: string, crop: CoverCrop): { id: string; path: string } {
    const record = this.record(id);
    const image = record.session.image;
    if (record.session.preparing || record.session.status !== 'ready' || !image) throw new Error(sourcesTexts.main.coverNotReady);
    if (
      !crop ||
      ![crop.x, crop.y, crop.size].every(Number.isSafeInteger) ||
      crop.x < 0 ||
      crop.y < 0 ||
      crop.size <= 0 ||
      crop.x + crop.size > image.width ||
      crop.y + crop.size > image.height
    )
      throw new Error(sourcesTexts.main.coverCropInvalid);
    const path = join(record.root, 'accepted.png');
    try {
      // Агент мог оставить одноимённый артефакт; обрезка должна создать собственный новый файл.
      rmSync(path, { force: true });
      this.options.cropImage(image.path, path, crop);
      const size = this.options.readImage(path);
      if (
        realpathSync(path) !== path ||
        lstatSync(path).isSymbolicLink() ||
        !isImageFile(path) ||
        !imageExtensionMatches(path) ||
        size?.width !== crop.size ||
        size.height !== crop.size
      )
        throw new Error(sourcesTexts.main.coverCropSaveFailed);
    } catch (error) {
      rmSync(path, { force: true });
      throw error;
    }
    this.clear(record, 'accepted.png');
    record.session.image = { path, width: crop.size, height: crop.size };
    record.session.status = 'accepted';
    record.prepared = undefined;
    record.session.requestSha = null;
    record.session.approvalToken = null;
    return { id, path };
  }

  async close(id: string): Promise<void> {
    const record = this.sessions.get(id);
    if (!record) return;
    record.closed = true;
    record.controller?.abort();
    await record.task;
    rmSync(record.root, { recursive: true, force: true });
    this.sessions.delete(id);
  }

  async shutdown(): Promise<void> {
    this.stopping = true;
    await Promise.all([...this.sessions.keys()].map((id) => this.close(id)));
  }

  private record(id: string): Record {
    const record = this.sessions.get(id);
    if (!record || record.closed) throw new Error(sourcesTexts.main.coverSessionClosed);
    return record;
  }
  private clear(record: Record, keep?: string): void {
    for (const name of readdirSync(record.root)) if (name !== keep) rmSync(join(record.root, name), { recursive: true, force: true });
  }
  private async run(record: Record, prepared: { candidate: PreparedCoverCandidate; workDir: string }, approval: { allowUnknownCost: boolean }): Promise<void> {
    if (record.closed) return;
    const workDir = prepared.workDir;
    try {
      // Настройки могли измениться между подтверждением и отложенным запуском исполнителя.
      assertAiSelection(this.options.settings, record.project, 'image');
      if (readProjectSettings(record.project).generation?.image?.provider !== prepared.candidate.provider)
        throw new Error(sourcesTexts.main.coverProviderChanged);
      const output = await prepared.candidate.generate(record.controller!.signal, approval);
      if (record.closed) return;
      const path = resolve(workDir, output.path);
      const local = relative(workDir, path);
      if (
        !local ||
        isAbsolute(local) ||
        local === '..' ||
        local.startsWith('../') ||
        local.startsWith('..\\') ||
        realpathSync(path) !== path ||
        lstatSync(path).isSymbolicLink() ||
        !isImageFile(path) ||
        !imageExtensionMatches(path)
      )
        throw new Error(sourcesTexts.main.coverFileInvalid);
      const size = this.options.readImage(path);
      if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0)
        throw new Error(sourcesTexts.main.coverImageReadFailed);
      record.session.image = { path, ...size };
      record.session.status = 'ready';
    } catch (error) {
      if (record.closed) return;
      this.clear(record);
      record.session.image = null;
      record.session.status = 'failed';
      record.session.error = error instanceof Error && !('code' in error) ? error.message : sourcesTexts.main.coverFileReadFailed;
    }
  }
}
