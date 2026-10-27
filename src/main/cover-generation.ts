/** Обложка живёт во временной сессии; только общая форма переносит принятый PNG в проект. */
import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readdirSync, realpathSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import type { AgentJob, AgentSettings } from '@shared/agents';
import type { CoverCrop, CoverGenerationApproval, CoverGenerationSession } from '@shared/cover-generation';
import { COVER_AGENT_REQUIRED } from '@shared/cover-generation';
import { priceAllowsGeneration } from '@shared/generation-consent';
import { AgentManager } from './agent-manager';
import { readProjectSettings } from './checks';
import { imageExtensionMatches, isImageFile } from './keyframe-images';
import { SettingsStore } from './settings';
import { assertAiSelection } from './ai-access';

type Manager = Pick<AgentManager, 'startImages' | 'get' | 'onEvent' | 'shutdownAndWait'>;
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
  prepareCandidate?: (input: PreparedCoverCandidateInput) => Promise<PreparedCoverCandidate>;
  createManager?: (settings: SettingsStore) => Manager;
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

const IMAGE_PROMPT =
  'Создай одну квадратную обложку по пользовательскому описанию из дополнительного контекста. ' +
  'Обязательно используй встроенный инструмент image_gen, создай настоящее изображение и сохрани один результат в текущей рабочей папке. ' +
  'Разрешены PNG, JPEG и WebP; расширение обязано соответствовать реальному формату. ' +
  'Не используй Kling, API-ключи, программную отрисовку, SVG, заглушки, имитацию или сторонние генераторы. ' +
  'Если встроенный image_gen недоступен, заверши задачу с объяснением ошибки. ' +
  'Не изменяй исходный проект и не выполняй commit/push. Финальный ответ — ровно один JSON без Markdown: {"path":"cover.png"}. ' +
  'Для JPEG или WebP укажи соответствующее имя созданного файла.';

/** Codex получает только временный проект: его история и все разрешённые записи остаются рядом с кандидатом. */
export function createCodexCoverRunner(
  settings: SettingsStore,
  createManager: (settings: SettingsStore) => Manager = (value) => new AgentManager(value),
  config: AgentSettings = settings.getImageAgent()
): CoverCandidateRunner {
  return async ({ workDir, prompt, signal }) => {
    if (signal.aborted) throw new Error('Генерация обложки остановлена.');
    const root = dirname(dirname(workDir));
    const temporarySettings = new SettingsStore(root);
    temporarySettings.saveImageAgent(config);
    mkdirSync(join(root, 'plan'), { recursive: true });
    writeFileSync(join(root, 'plan/project.json'), '{}');
    const manager = createManager(temporarySettings);
    const stop = (): void => {
      void manager.shutdownAndWait();
    };
    signal.addEventListener('abort', stop, { once: true });
    let unsubscribe: (() => void) | undefined;
    try {
      const job = manager.startImages(
        { project: root, task: 'Обложка проекта', prompt: IMAGE_PROMPT, context: JSON.stringify({ userPrompt: prompt }) },
        workDir
      );
      const completed = await new Promise<AgentJob>((finish) => {
        const check = (): void => {
          const current = manager.get(job.id);
          if (current && current.status !== 'running') finish(current);
        };
        unsubscribe = manager.onEvent(check);
        check();
      });
      if (signal.aborted) throw new Error('Генерация обложки остановлена.');
      if (completed.status !== 'completed' || completed.exitCode !== 0)
        throw new Error(completed.message || 'Агент не смог создать обложку. Проверьте доступность встроенного image_gen.');
      let response: unknown;
      try {
        response = JSON.parse(completed.result);
      } catch {
        throw new Error('Агент не вернул путь к созданной обложке.');
      }
      if (
        !response ||
        typeof response !== 'object' ||
        Array.isArray(response) ||
        Object.keys(response).length !== 1 ||
        typeof (response as { path?: unknown }).path !== 'string'
      )
        throw new Error('Агент вернул неверный результат обложки. Ожидается JSON с одним полем path.');
      return { path: (response as { path: string }).path };
    } finally {
      unsubscribe?.();
      signal.removeEventListener('abort', stop);
      await manager.shutdownAndWait();
    }
  };
}

export class CoverGeneration {
  private readonly sessions = new Map<string, Record>();
  private readonly prepareCandidate: NonNullable<CoverGenerationOptions['prepareCandidate']>;
  private stopping = false;
  constructor(private readonly options: CoverGenerationOptions) {
    this.prepareCandidate =
      options.prepareCandidate ??
      (async (input) => {
        const imageSettings = readProjectSettings(input.project).generation?.image;
        if (imageSettings?.provider !== 'codex') throw new Error('Для Kling подключите подготовку запроса выбранного провайдера изображений.');
        // Самостоятельный Codex runner соблюдает тот же выбор проектной модели, что и общий coordinator.
        const config = { ...options.settings.getImageAgent(), model: imageSettings.model?.trim() || undefined };
        const runner = createCodexCoverRunner(options.settings, options.createManager, config);
        return {
          provider: 'codex',
          model: config.model ?? null,
          requestSha: createHash('sha256')
            .update(JSON.stringify({ prompt: input.prompt, config, workDir: input.workDir }))
            .digest('hex'),
          quote: null,
          generate: (signal) => runner({ ...input, signal })
        };
      });
  }

  create(project: string, prompt: string): CoverGenerationSession {
    if (this.stopping) throw new Error('Приложение завершает работу.');
    // Глобальный выбор агента обязателен: профиль изображений не включает генерацию самостоятельно.
    if (!this.options.settings.getAgent()) throw new Error(COVER_AGENT_REQUIRED);
    if (typeof project !== 'string' || !isAbsolute(project) || project.includes('\0')) throw new Error('Выберите папку проекта.');
    let canonical: string;
    try {
      canonical = realpathSync(project);
    } catch {
      throw new Error('Папка проекта не найдена. Выберите её заново.');
    }
    if (!existsSync(join(canonical, 'plan/project.json'))) throw new Error('В папке нет plan/project.json.');
    const imageSettings = readProjectSettings(canonical).generation?.image;
    if (imageSettings?.provider !== 'codex' && imageSettings?.provider !== 'kling')
      throw new Error('Выберите поддерживаемого провайдера изображений в настройках проекта: Codex или Kling.');
    assertAiSelection(this.options.settings, canonical, 'image');
    if (typeof prompt !== 'string' || !prompt.trim() || prompt.includes('\0') || Buffer.byteLength(prompt) > 32 * 1024)
      throw new Error('Введите описание обложки длиной не более 32 КБ.');
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
    if (!this.options.settings.getAgent()) throw new Error(COVER_AGENT_REQUIRED);
    assertAiSelection(this.options.settings, record.project, 'image');
    if (record.session.preparing || record.session.status === 'generating') throw new Error('Дождитесь завершения подготовки или генерации обложки.');
    if (record.session.status === 'accepted') throw new Error('Обложка уже выбрана.');
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
        const candidate = await this.prepareCandidate({ workDir, project: record.project, prompt: record.session.prompt, signal: record.controller!.signal });
        if (record.closed) return;
        if (!candidate.requestSha || !['codex', 'kling'].includes(candidate.provider)) throw new Error('Не удалось подготовить запрос обложки.');
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
        record.session.error = error instanceof Error ? error.message : 'Не удалось подготовить генерацию обложки.';
      } finally {
        record.session.preparing = false;
      }
    })();
    await record.task;
    return this.view(id);
  }

  generate(id: string, requestSha: string, approval: CoverGenerationApproval): CoverGenerationSession {
    const record = this.record(id);
    if (!this.options.settings.getAgent()) throw new Error(COVER_AGENT_REQUIRED);
    assertAiSelection(this.options.settings, record.project, 'image');
    if (record.session.preparing || record.session.status === 'generating') throw new Error('Дождитесь завершения подготовки или генерации обложки.');
    if (record.session.status === 'accepted') throw new Error('Обложка уже выбрана. Откройте новую сессию для другой обложки.');
    const prepared = record.prepared;
    if (!prepared || !requestSha || prepared.candidate.requestSha !== requestSha) throw new Error('Сначала подготовьте и проверьте новый запрос обложки.');
    // Согласие относится к показанному промпту и этой подготовке, даже когда SHA следующей попытки совпадает.
    if (approval?.promptConfirmed !== true || !record.session.approvalToken || approval.approvalToken !== record.session.approvalToken)
      throw new Error('Подтвердите показанный промпт для текущей попытки генерации обложки.');
    if (readProjectSettings(record.project).generation?.image?.provider !== prepared.candidate.provider)
      throw new Error('Провайдер изображений изменился. Подготовьте новый запрос обложки.');
    if (prepared.candidate.provider === 'kling' && !priceAllowsGeneration(prepared.candidate.quote, approval.allowUnknownCost === true))
      throw new Error('Стоимость или баланс Kling не позволяют отправить этот запрос.');
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
    if (record.session.preparing || record.session.status !== 'ready' || !image) throw new Error('Сначала дождитесь готовой обложки.');
    if (
      !crop ||
      ![crop.x, crop.y, crop.size].every(Number.isSafeInteger) ||
      crop.x < 0 ||
      crop.y < 0 ||
      crop.size <= 0 ||
      crop.x + crop.size > image.width ||
      crop.y + crop.size > image.height
    )
      throw new Error('Выберите квадратную область внутри изображения с целыми координатами.');
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
        throw new Error('Не удалось сохранить квадратную обложку в PNG.');
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
    if (!record || record.closed) throw new Error('Сессия обложки закрыта. Откройте генерацию заново.');
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
      if (!this.options.settings.getAgent()) throw new Error(COVER_AGENT_REQUIRED);
      assertAiSelection(this.options.settings, record.project, 'image');
      if (readProjectSettings(record.project).generation?.image?.provider !== prepared.candidate.provider)
        throw new Error('Провайдер изображений изменился. Подготовьте новый запрос обложки.');
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
        throw new Error('Нужен настоящий PNG, JPEG или WebP внутри временной папки обложки без символических ссылок.');
      const size = this.options.readImage(path);
      if (!size || !Number.isSafeInteger(size.width) || !Number.isSafeInteger(size.height) || size.width <= 0 || size.height <= 0)
        throw new Error('Не удалось прочитать созданное изображение обложки.');
      record.session.image = { path, ...size };
      record.session.status = 'ready';
    } catch (error) {
      if (record.closed) return;
      this.clear(record);
      record.session.image = null;
      record.session.status = 'failed';
      record.session.error = error instanceof Error && !('code' in error) ? error.message : 'Не удалось прочитать файл обложки. Создайте изображение заново.';
    }
  }
}
