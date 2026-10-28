/** Адаптер Codex: опоры рисует программа-агент; подготовка и отправка отделены от восстановления существующего задания. */
import { createHash } from 'node:crypto';
import { readFileSync, realpathSync } from 'node:fs';
import type { AgentCheckResult, AgentJob, AgentSettings } from '@shared/agents';
import { sameMediaProvider, type AgentMediaExecutionRef, type MediaCapabilities, type MediaModel } from '@shared/media-providers';
import type { ProductionImagesInput } from '@shared/production-workflow';
import { readProjectSettings } from '../../checks';
import { imageDimensions, type KeyframeImages } from '../../keyframe-images';
import { localFile, type MediaArtifact } from '../../media-providers';

export interface CodexImageProviderOptions {
  images: KeyframeImages;
  /** Программа-агент провайдера с моделью из настроек проекта. */
  agent: (model?: string) => AgentSettings;
  checkCodex: () => Promise<AgentCheckResult>;
  listCodexModels?: () => Promise<MediaModel[]>;
}
export interface PreparedCodexRequest {
  provider: 'codex';
  kind: 'image';
  requestSha: string;
  input: ProductionImagesInput;
  references: { path: string; sha256: string }[];
}
const hash = (value: string | Buffer): string => createHash('sha256').update(value).digest('hex');
const fileHash = (path: string): string => hash(readFileSync(path));

export class CodexImageProvider {
  readonly provider = 'codex';
  readonly kind = 'image';
  private readonly submittedRequests = new WeakSet<PreparedCodexRequest>();
  private readonly consumedPermits = new WeakSet<{ requestSha: string }>();

  constructor(private readonly options: CodexImageProviderOptions) {}

  async capabilities(_project: string): Promise<MediaCapabilities> {
    let available = false;
    let models: MediaModel[] = [];
    const problems: string[] = [];
    try {
      const diagnostic = await this.options.checkCodex();
      available = diagnostic.availability === 'available' && diagnostic.authorization !== 'unauthenticated';
      if (!available || diagnostic.authorization === 'unknown') problems.push(diagnostic.message);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
    if (available && this.options.listCodexModels) {
      try {
        models = await this.options.listCodexModels();
        if (!models.length) problems.push('Codex не вернул доступные модели агента.');
      } catch {
        problems.push('Каталог моделей агента Codex сейчас недоступен. Повторите проверку возможностей.');
      }
    }
    // Непроверенная генерация отражена generationVerified; это справка, а не ошибка успешной диагностики CLI.
    return { provider: 'codex', kind: 'image', available, checkedAt: new Date().toISOString(), models, problems, generationVerified: false };
  }

  prepare(input: ProductionImagesInput): PreparedCodexRequest {
    const frozen = structuredClone(input);
    frozen.project = realpathSync(input.project);
    if (!frozen.frames.length || frozen.frames.some((frame) => !/^K\d{2}$/.test(frame.id) || !frame.prompt.trim()))
      throw new Error('Сначала подготовьте описания опор.');
    const references = [...new Set(frozen.frames.flatMap((frame) => frame.referencePaths))].map((path) => {
      const file = localFile(frozen.project, path);
      if (!imageDimensions(file)) throw new Error('Референс не является изображением.');
      return { path: file, sha256: fileHash(file) };
    });
    const requestSha = hash(JSON.stringify({ input: frozen, references }));
    return { provider: 'codex', kind: 'image', requestSha, input: frozen, references };
  }

  submit(prepared: PreparedCodexRequest, permit: { requestSha: string }): AgentMediaExecutionRef {
    if (this.submittedRequests.has(prepared) || this.consumedPermits.has(permit))
      throw new Error('Эта подготовка или подтверждение уже использованы. Для нового запуска подготовьте и подтвердите новый запрос.');
    if (
      prepared.provider !== 'codex' ||
      prepared.kind !== 'image' ||
      permit.requestSha !== prepared.requestSha ||
      this.prepare(prepared.input).requestSha !== prepared.requestSha
    )
      throw new Error('Запрос или референсы изменились после согласования.');
    // Подтверждение расходуется до запуска: исключение start не разрешает неявный повтор.
    // Новые prepared/permit допускают отдельно согласованную генерацию тех же входов и SHA.
    this.submittedRequests.add(prepared);
    this.consumedPermits.add(permit);
    // Модель проекта относится только к этому провайдеру изображений; без неё выбор остаётся программе.
    const image = readProjectSettings(prepared.input.project).generation?.image;
    const agent = this.options.agent(sameMediaProvider(image?.provider, this.provider) ? image?.model : undefined);
    const job = this.options.images.start(prepared.input, { provider: this.provider, requestSha: prepared.requestSha, agent });
    return { provider: 'codex', kind: 'image', requestSha: prepared.requestSha, agentJobId: job.id };
  }

  collect(reference: AgentMediaExecutionRef, job: AgentJob): MediaArtifact[] {
    if (job.id !== reference.agentJobId) throw new Error('Неверное задание для согласованного запроса.');
    return this.options.images.collect(job, reference.requestSha).map((candidate, index) => ({
      path: candidate.path,
      index: index + 1,
      frameId: candidate.id,
      kind: 'image',
      sha256: fileHash(candidate.path),
      ...imageDimensions(candidate.path)!
    }));
  }

  /** После перезапуска ref задания восстанавливается из image-jobs/job.json. */
  collectJob(job: AgentJob): MediaArtifact[] {
    return this.collect({ provider: this.provider, kind: 'image', requestSha: this.options.images.getRequestSha(job), agentJobId: job.id }, job);
  }
}
