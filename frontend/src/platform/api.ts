/**
 * Единственная реализация window.api: каждый метод контракта shared/api.ts вызывает
 * сгенерированный binding Wails. Ответы Go не перепроверяются вручную — соответствие типов
 * bindings ↔ shared/types проверяет typecheck, а отсутствие null в коллекциях гарантирует
 * wire.Fill на стороне Go. Каркас api-skeleton перечисляет все методы контракта, а тест адаптера
 * проверяет, что каждый из них подключён здесь к binding.
 */
import type { Api } from '@shared/api';
import type {
  AcceptedKit,
  ProjectHistoryStatus,
  ProjectPoint,
  ProjectRestoreResult,
  ProjectScenarioComparison,
  PromptLogRecord,
  PromptLogSummary,
  ShotSpend,
  ProjectSpend,
  ResultMedia,
  AnimaticView,
  AppState,
  BriefResult,
  CheckId,
  DashboardView,
  EnvironmentCheck,
  GenerationSettings,
  JobInfo,
  JobStepInfo,
  PackageView,
  PickOptions,
  ProductionQuote,
  ProductionView,
  ProjectSettings,
  ProjectStatus,
  ScenarioImpactShot,
  SourceManifest,
  SpeechPlan,
  TimingFile
} from '@shared/types';
import type { ScenarioStatus } from '@shared/scenario-status';
import type * as status from '../../bindings/songframe/internal/status/models';
import type * as jobs from '../../bindings/songframe/internal/jobs/models';
import type * as checks from '../../bindings/songframe/internal/checks/models';
import type * as songtiming from '../../bindings/songframe/internal/songtiming/models';
import type * as agentModels from '../../bindings/songframe/internal/agents/models';
import type { AgentCheckResult, AgentDiagnosticCode, AgentEvent, AgentJob, AgentSettings } from '@shared/agents';
import type * as videoReviewModels from '../../bindings/songframe/internal/videoreview/models';
import type { VideoReviewFinding, VideoReviewView } from '@shared/video-review';
import type * as covergen from '../../bindings/songframe/internal/covergen/models';
import type * as referenceimage from '../../bindings/songframe/internal/referenceimage/models';
import type { CoverGenerationSession } from '@shared/cover-generation';
import type { ReferenceImageGenerationInput } from '@shared/reference-image-generation';
import type { AiAccess } from '@shared/ai-access';
import type { UpdateView } from '@shared/updates';
import type * as scenarioworkflow from '../../bindings/songframe/internal/scenarioworkflow/models';
import type { ScenarioDocuments, ScenarioProposal, ScenarioWorkflowView } from '@shared/scenario-workflow';
import type * as productionworkflow from '../../bindings/songframe/internal/productionworkflow/models';
import type { ProductionFramePrompt, ProductionPass, ProductionProposal, ProductionWorkflowView } from '@shared/production-workflow';
import type { VocalModelId, VocalPreparationView } from '@shared/vocals';
import type { NotificationTarget } from '@shared/notifications';
import type { MontageWindowEvent } from '@shared/montage-window';
import type { MontageDraft, MontageView } from '@shared/montage';
import type { DerivedShotView } from '@shared/derived-shot';
import type * as mediaapi from '../../bindings/songframe/internal/mediaapi/models';
import type { MediaCapabilities, MediaKind, ProviderAuth } from '@shared/media-providers';
import { componentTexts } from '@shared/texts/component-manager';
import { platformTexts } from '@shared/texts/platform';
import { apiSkeleton, type ApiMethod } from './api-skeleton';
import { fileUrl } from './file-url';

export type { ApiMethod } from './api-skeleton';

/** Ошибка сохраняет технический код и метод для диагностики, не превращая отказ в успешную пустую выдачу. */
export class ApiError extends Error {
  constructor(
    public readonly code: 'TIMEOUT' | 'CONNECTION_FAILED' | 'SERVICE_FAILED',
    public readonly method: string,
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
    this.name = 'ApiError';
  }
}

/** Таймаут ограничивает ожидание оболочки; поздний результат не отменяет показанную ошибку и не меняет UI. */
export async function withDeadline<T>(operation: () => Promise<T>, method: string, milliseconds = 10000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      Promise.resolve().then(operation),
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => reject(new ApiError('TIMEOUT', method, platformTexts.timeout)), milliseconds);
      })
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Перевод ошибок вызова: RuntimeError — ответ работающего Go-сервиса, его текст показывается
 * пользователю как есть; остальное — сбой связи с оболочкой. Диалоги ждут пользователя без срока.
 */
async function call<T>(method: ApiMethod | 'frontendReady', work: () => Promise<T>, deadline = true): Promise<T> {
  try {
    return await (deadline ? withDeadline(work, method) : work());
  } catch (error) {
    if (error instanceof ApiError) throw error;
    if (error instanceof Error && error.name === 'RuntimeError') throw new ApiError('SERVICE_FAILED', method, error.message, { cause: error });
    throw new ApiError('CONNECTION_FAILED', method, platformTexts.connectionFailed, { cause: error });
  }
}

/** Источник событий Go; в тестах подменяется без настоящего runtime. */
export type EventSource = () => Promise<{ on: (name: string, listener: (event: { data: unknown }) => void) => () => void }>;

/**
 * Подписка на событие Go через отложенный import runtime: отписка доступна сразу,
 * поздние события после неё отбрасываются, сбой загрузки runtime уходит в console.error.
 */
export function subscribe<T>(events: EventSource, name: string, listener: (value: T) => void): () => void {
  let disposed = false;
  let unsubscribe: (() => void) | undefined;
  void events()
    .then((source) => {
      if (disposed) return;
      unsubscribe = source.on(name, (event) => {
        if (!disposed) listener(event.data as T);
      });
    })
    .catch((error: unknown) => {
      if (!disposed) console.error(error);
    });
  return () => {
    disposed = true;
    unsubscribe?.();
  };
}

/** Модули bindings загружаются при первом вызове: Storybook и unit-тесты не запускают Wails runtime. */
export interface Bindings {
  app: () => Promise<typeof import('../../bindings/songframe/internal/app/appservice')>;
  shell: () => Promise<typeof import('../../bindings/songframe/internal/app/shellservice')>;
  native: () => Promise<typeof import('../../bindings/songframe/internal/app/nativeservice')>;
  components: () => Promise<typeof import('../../bindings/songframe/internal/app/componentsservice')>;
  jobs: () => Promise<typeof import('../../bindings/songframe/internal/app/jobsservice')>;
  projects: () => Promise<typeof import('../../bindings/songframe/internal/app/projectservice')>;
  timing: () => Promise<typeof import('../../bindings/songframe/internal/app/timingservice')>;
  sources: () => Promise<typeof import('../../bindings/songframe/internal/app/sourcesservice')>;
  cast: () => Promise<typeof import('../../bindings/songframe/internal/app/castservice')>;
  scenario: () => Promise<typeof import('../../bindings/songframe/internal/app/scenarioservice')>;
  tools: () => Promise<typeof import('../../bindings/songframe/internal/app/toolsservice')>;
  checks: () => Promise<typeof import('../../bindings/songframe/internal/app/checksservice')>;
  agents: () => Promise<typeof import('../../bindings/songframe/internal/app/agentsservice')>;
  ai: () => Promise<typeof import('../../bindings/songframe/internal/app/aiservice')>;
  scenarioWorkflow: () => Promise<typeof import('../../bindings/songframe/internal/app/scenarioworkflowservice')>;
  productionWorkflow: () => Promise<typeof import('../../bindings/songframe/internal/app/productionworkflowservice')>;
  videoReview: () => Promise<typeof import('../../bindings/songframe/internal/app/videoreviewservice')>;
  cover: () => Promise<typeof import('../../bindings/songframe/internal/app/coverservice')>;
  referenceImages: () => Promise<typeof import('../../bindings/songframe/internal/app/referenceimagesservice')>;
  environment: () => Promise<typeof import('../../bindings/songframe/internal/app/environmentservice')>;
  media: () => Promise<typeof import('../../bindings/songframe/internal/app/mediaservice')>;
  production: () => Promise<typeof import('../../bindings/songframe/internal/app/productionservice')>;
  dashboard: () => Promise<typeof import('../../bindings/songframe/internal/app/dashboardservice')>;
  animatic: () => Promise<typeof import('../../bindings/songframe/internal/app/animaticservice')>;
  promptLog: () => Promise<typeof import('../../bindings/songframe/internal/app/promptlogservice')>;
  projectHistory: () => Promise<typeof import('../../bindings/songframe/internal/app/projecthistoryservice')>;
  montage: () => Promise<typeof import('../../bindings/songframe/internal/app/montageservice')>;
  montageWindow: () => Promise<typeof import('../../bindings/songframe/internal/app/montagewindowservice')>;
  derivedShots: () => Promise<typeof import('../../bindings/songframe/internal/app/derivedshotservice')>;
  updates: () => Promise<typeof import('../../bindings/songframe/internal/app/updatesservice')>;
  events: EventSource;
}

export const nativeBindings: Bindings = {
  app: () => import('../../bindings/songframe/internal/app/appservice'),
  shell: () => import('../../bindings/songframe/internal/app/shellservice'),
  native: () => import('../../bindings/songframe/internal/app/nativeservice'),
  components: () => import('../../bindings/songframe/internal/app/componentsservice'),
  jobs: () => import('../../bindings/songframe/internal/app/jobsservice'),
  projects: () => import('../../bindings/songframe/internal/app/projectservice'),
  timing: () => import('../../bindings/songframe/internal/app/timingservice'),
  sources: () => import('../../bindings/songframe/internal/app/sourcesservice'),
  cast: () => import('../../bindings/songframe/internal/app/castservice'),
  scenario: () => import('../../bindings/songframe/internal/app/scenarioservice'),
  tools: () => import('../../bindings/songframe/internal/app/toolsservice'),
  checks: () => import('../../bindings/songframe/internal/app/checksservice'),
  agents: () => import('../../bindings/songframe/internal/app/agentsservice'),
  ai: () => import('../../bindings/songframe/internal/app/aiservice'),
  scenarioWorkflow: () => import('../../bindings/songframe/internal/app/scenarioworkflowservice'),
  productionWorkflow: () => import('../../bindings/songframe/internal/app/productionworkflowservice'),
  videoReview: () => import('../../bindings/songframe/internal/app/videoreviewservice'),
  cover: () => import('../../bindings/songframe/internal/app/coverservice'),
  referenceImages: () => import('../../bindings/songframe/internal/app/referenceimagesservice'),
  environment: () => import('../../bindings/songframe/internal/app/environmentservice'),
  media: () => import('../../bindings/songframe/internal/app/mediaservice'),
  production: () => import('../../bindings/songframe/internal/app/productionservice'),
  dashboard: () => import('../../bindings/songframe/internal/app/dashboardservice'),
  animatic: () => import('../../bindings/songframe/internal/app/animaticservice'),
  promptLog: () => import('../../bindings/songframe/internal/app/promptlogservice'),
  projectHistory: () => import('../../bindings/songframe/internal/app/projecthistoryservice'),
  montage: () => import('../../bindings/songframe/internal/app/montageservice'),
  montageWindow: () => import('../../bindings/songframe/internal/app/montagewindowservice'),
  derivedShots: () => import('../../bindings/songframe/internal/app/derivedshotservice'),
  updates: () => import('../../bindings/songframe/internal/app/updatesservice'),
  events: async () => {
    const { Events } = await import('@wailsio/runtime');
    return { on: Events.On };
  }
};

/**
 * Go-перечисления (jobs.Kind, Status, StepStatus) генерируются как TS enum с теми же строками,
 * а контракт объявляет строковые объединения; значения совпадают, сужается только тип.
 * Необязательные error и modelDownload Go опускает (omitempty, указатели); генератор пишет их
 * как `?: T | null`, а контракт — как `?: T`, поэтому поля копируются только при наличии.
 */
function toJob({ modelDownload, error, ...info }: jobs.Info): JobInfo {
  const job: JobInfo = {
    ...info,
    kind: info.kind as JobInfo['kind'],
    status: info.status as JobInfo['status'],
    steps: info.steps.map((step) => ({ ...step, status: step.status as JobStepInfo['status'] }))
  };
  if (error != null) job.error = error;
  if (modelDownload) job.modelDownload = { ...modelDownload, model: modelDownload.model as NonNullable<JobInfo['modelDownload']>['model'] };
  return job;
}

/**
 * Вид сценарного прохода: проход, статус предложения и задания агента Go хранит строками,
 * документы предложения — JSON { cast, treatment, scenes } в формате файлов проекта. Необязательное message
 * Go опускает (omitempty), поэтому оно копируется только при наличии.
 */
function toWorkflowView({ proposal, job, ...view }: scenarioworkflow.View): ScenarioWorkflowView {
  let next: ScenarioProposal | null = null;
  if (proposal) {
    const { message, ...rest } = proposal;
    next = {
      ...rest,
      pass: proposal.pass as ScenarioProposal['pass'],
      status: proposal.status as ScenarioProposal['status'],
      before: proposal.before as ScenarioDocuments,
      after: proposal.after as ScenarioDocuments
    };
    if (message) next.message = message;
  }
  return {
    ...view,
    changedInputs: view.changedInputs as ScenarioWorkflowView['changedInputs'],
    proposal: next,
    job: job ? (job as unknown as AgentJob) : null
  };
}

/**
 * Вид прохода агента производства: план опор, ID опор и предложение — документы пакета и
 * локальной записи, которые Go передаёт сырыми JSON-значениями; провайдеры — значения настроек
 * проекта как есть (поле отсутствует без значения). Адаптер только сужает типы.
 */
function toProductionWorkflowView({
  imageProvider,
  videoProvider,
  nextStage,
  generationMethod,
  framePrompts,
  nextFrame,
  approvedFrameIds,
  proposal,
  job,
  ...view
}: productionworkflow.View): ProductionWorkflowView {
  return {
    ...view,
    ...(nextStage ? { nextStage: nextStage as ProductionPass } : {}),
    ...(generationMethod === 'manual' ? { generationMethod } : {}),
    ...(imageProvider === undefined ? {} : { imageProvider: imageProvider as string }),
    ...(videoProvider === undefined ? {} : { videoProvider: videoProvider as string }),
    framePrompts: framePrompts as ProductionFramePrompt[],
    nextFrame: nextFrame as string | null,
    approvedFrameIds: approvedFrameIds as string[],
    proposal: proposal as ProductionProposal | null,
    job: job === null ? null : toAgentJob(job)
  };
}

/** ID моделей вокала — закрытый набор VOCAL_MODELS; Go хранит их строкой. */
const toVocals = (view: songtiming.VocalPreparationView): VocalPreparationView => ({
  ...view,
  models: view.models.map((model) => ({ ...model, id: model.id as VocalModelId })),
  results: view.results.map((result) => ({ ...result, modelId: result.modelId as VocalModelId }))
});

/** Состояние проекта — закрытый набор строк computeStatus; Go хранит его строкой. */
const toStatus = (value: status.ProjectStatus): ProjectStatus => ({ ...value, state: value.state as ProjectStatus['state'] });

/**
 * Пути ключей generation со значением undefined. Такой ключ означает удаление поля
 * при записи (сброс модели или разрешения); JSON-мост Wails его теряет, поэтому Go получает пути списком.
 */
export function undefinedPaths(value: unknown, prefix: string[] = []): string[][] {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return [];
  return Object.entries(value).flatMap(([key, item]) => (item === undefined ? [[...prefix, key]] : undefinedPaths(item, [...prefix, key])));
}

/** generation — блок plan/project.json как есть (json.RawMessage), null — блока нет или он не объект. */
const toSettings = (value: { agentInstructions: string; name: string; animaticVideo: string; generation: unknown }): ProjectSettings => ({
  ...value,
  generation: value.generation as GenerationSettings | null
});

/**
 * Агент, состояние задания, права и код диагностики — закрытые наборы строк реестра и контракта;
 * Go хранит их строкой, поэтому сужается только тип. Необязательный diagnostic Go опускает.
 */
const toAgentSettings = (value: agentModels.Settings): AgentSettings => ({ ...value, provider: value.provider as AgentSettings['provider'] });
const toAgentSettingsOrNull = (value: agentModels.Settings | null): AgentSettings | null => (value === null ? null : toAgentSettings(value));
const toAgentCheck = (value: agentModels.CheckResult): AgentCheckResult => ({
  ...value,
  availability: value.availability as AgentCheckResult['availability'],
  authorization: value.authorization as AgentCheckResult['authorization']
});
/** Номер вызова environment.check: события прогресса относятся к своему вызову. */
let environmentRequest = 0;

/** Строка «Среды» Go: необязательные поля опускаются, статус — значение контракта. */
function toEnvironmentCheck(check: mediaapi.EnvironmentCheck): EnvironmentCheck {
  const { elapsedMs, status, bundled, external, loginProvider, ...rest } = check;
  return {
    ...rest,
    ...(elapsedMs === undefined || elapsedMs === null ? {} : { elapsedMs }),
    ...(status ? { status: status as NonNullable<EnvironmentCheck['status']> } : {}),
    ...(bundled === undefined || bundled === null ? {} : { bundled }),
    ...(external === undefined || external === null ? {} : { external }),
    ...(loginProvider ? { loginProvider } : {})
  };
}

/** Состояние входа: Go отдаёт строку состояния из закрытого набора контракта. */
function toProviderAuth(auth: agentModels.ProviderAuth): ProviderAuth {
  return { status: auth.status as ProviderAuth['status'], ...(auth.message === undefined ? {} : { message: auth.message }) };
}

/** Объявления моделей: arguments, slots и limits Go передаёт JSON как есть (json.RawMessage). */
function toMediaCapabilities(caps: mediaapi.Capabilities): MediaCapabilities {
  return {
    ...caps,
    kind: caps.kind as MediaKind,
    models: caps.models.map((model) => ({
      id: model.id,
      command: model.command,
      arguments: model.arguments as MediaCapabilities['models'][number]['arguments'],
      slots: model.slots as MediaCapabilities['models'][number]['slots'],
      limits: model.limits as Record<string, unknown>
    }))
  };
}

function toAgentJob({ diagnostic, ...job }: agentModels.Job): AgentJob {
  return {
    ...job,
    schemaVersion: job.schemaVersion as AgentJob['schemaVersion'],
    provider: job.provider as AgentJob['provider'],
    permissions: job.permissions as AgentJob['permissions'],
    status: job.status as AgentJob['status'],
    ...(diagnostic ? { diagnostic: diagnostic as AgentDiagnosticCode } : {})
  };
}

/** Статус, провайдер и вердикт цены — закрытые наборы строк CoverGenerationSession. */
const toCoverSession = (session: covergen.Session): CoverGenerationSession => ({
  ...session,
  status: session.status as CoverGenerationSession['status'],
  provider: session.provider as CoverGenerationSession['provider'],
  quote: session.quote ? { ...session.quote, verdict: session.quote.verdict as NonNullable<CoverGenerationSession['quote']>['verdict'] } : null
});
/** Необязательный SHA опоры передаётся только при наличии: отсутствие поля и null в Go равнозначны. */
const toGenerationInput = (input: ReferenceImageGenerationInput): referenceimage.GenerationInput => ({
  images: input.images.map((image) => ({ path: image.path, label: image.label, ...(image.sha256 === undefined ? {} : { sha256: image.sha256 }) }))
});

/**
 * Состояние проверки, вердикт и версия отчёта — закрытые наборы строк контракта VideoReviewView;
 * Go хранит их строкой и числом, поэтому сужается только тип. Задание агента — общий toAgentJob.
 */
const toVideoReview = (view: videoReviewModels.View): VideoReviewView => ({
  ...view,
  status: view.status as VideoReviewView['status'],
  job: view.job === null ? null : toAgentJob(view.job),
  report:
    view.report === null
      ? null
      : {
          ...view.report,
          schemaVersion: view.report.schemaVersion as 1,
          findings: view.report.findings.map((finding) => ({ ...finding, verdict: finding.verdict as VideoReviewFinding['verdict'] }))
        }
});

const pickOptions = (options?: PickOptions) => ({ title: options?.title ?? '', filters: options?.filters ?? [], multiple: options?.multiple ?? false });

/** Заголовок связывает системный диалог с карточкой: одинаковые кнопки не должны путать FFmpeg и ORT. */
function componentFolderTitle(component?: string): string {
  if (component === 'ffmpeg') return componentTexts.selectFFmpegFolder;
  if (component === 'ort-cpu') return componentTexts.selectORTFolder;
  if (component === 'ctc-ru' || component === 'ctc-vocab') return componentTexts.selectCTCFolder;
  return componentTexts.selectManagedFolder;
}

/**
 * Собирает window.api поверх bindings. Базовый адрес файлов загружается вместе с первым
 * app.state: страницы обращаются к fileUrl только после старта, поэтому он синхронен.
 */
export function createApi(b: Bindings): Api {
  const api = apiSkeleton();
  let fileBase: string | null = null;
  let fileBaseLoad: Promise<void> | null = null;
  /**
   * Базовый адрес файлов читается один раз; одновременные вызовы ждут общий запрос, а ошибка
   * не запоминается — следующий вызов повторит чтение.
   */
  const loadFileBase = (): Promise<void> => {
    if (fileBase !== null) return Promise.resolve();
    fileBaseLoad ??= (async () => {
      fileBase = await (await b.shell()).FileBase();
    })().finally(() => {
      fileBaseLoad = null;
    });
    return fileBaseLoad;
  };
  /**
   * Сообщения окна плеера уходят в Go строго по очереди: вызовы binding Wails выполняются
   * параллельно, а окно должно получать их в порядке отправки (state после state, frame после frame).
   */
  let montageQueue: Promise<void> = Promise.resolve();

  api.app.state = () =>
    call('app.state', async () => {
      await loadFileBase();
      const state = await (await b.app()).State();
      // Платформа — закрытый набор значений Go (runtime.GOOS, Windows → win32); тип строки не сужается генератором.
      return { ...state, platform: state.platform as AppState['platform'] } satisfies AppState;
    });

  api.dialog.pickFolder = (options) => call('dialog.pickFolder', async () => (await b.native()).PickFolder(pickOptions(options)), false);
  api.dialog.pickFiles = (options) => call('dialog.pickFiles', async () => (await b.native()).PickFiles(pickOptions(options)), false);

  api.shell.openPath = (path) => call('shell.openPath', async () => (await b.shell()).OpenPath(path));
  api.shell.openExternal = (url) => call('shell.openExternal', async () => (await b.shell()).OpenExternal(url));
  api.shell.readText = (path) => call('shell.readText', async () => (await b.shell()).ReadText(path));
  api.shell.clipboardText = () => call('shell.clipboardText', async () => (await b.shell()).ClipboardText());
  api.shell.fileUrl = (path) => {
    if (fileBase === null) throw new ApiError('CONNECTION_FAILED', 'shell.fileUrl', platformTexts.connectionFailed);
    return fileUrl(fileBase, path);
  };
  api.shell.onFilesDropped = (listener) =>
    subscribe<{ targetID: string; paths: string[] }>(b.events, 'native:files-dropped', (drop) => listener({ targetId: drop.targetID, paths: drop.paths }));

  api.montageWindow.open = (session) => call('montageWindow.open', async () => (await b.montageWindow()).Open(session));
  api.montageWindow.close = (session) => call('montageWindow.close', async () => (await b.montageWindow()).Close(session));
  // send контракта синхронный: ошибка доставки не возвращается вызывающему, а уходит в журнал.
  api.montageWindow.send = (message) => {
    montageQueue = montageQueue
      .then(() => call('montageWindow.send', async () => (await b.montageWindow()).Send(message)))
      .catch((error: unknown) => console.error(error));
  };
  /**
   * Окно плеера не проходит app.state (оно вне AppProvider), а его плеер строит адреса кадров
   * синхронным shell.fileUrl. Поэтому сообщения доставляются после загрузки базового адреса
   * файлов — в порядке прихода, и ни одно не приходит после отписки.
   */
  api.montageWindow.onMessage = (listener) => {
    let active = true;
    const base = loadFileBase().catch((error: unknown) => console.error(error));
    const stop = subscribe<MontageWindowEvent>(b.events, 'montage-window:message', (event) => {
      void base.then(() => {
        if (active) listener(event);
      });
    });
    return () => {
      active = false;
      stop();
    };
  };
  api.montageWindow.onClosed = (listener) => subscribe<string>(b.events, 'montage-window:closed', listener);

  api.diagnostics.reportRendererError = (report) => {
    void call('diagnostics.reportRendererError', async () => (await b.native()).ReportRendererError(report)).catch((error: unknown) => console.error(error));
  };
  api.diagnostics.crashNotice = () => call('diagnostics.crashNotice', async () => (await b.native()).CrashNotice());
  api.diagnostics.saveReport = () => call('diagnostics.saveReport', async () => (await b.native()).SaveReport(), false);

  api.projects.open = (path) => call('projects.open', async () => toStatus(await (await b.projects()).Open(path)));
  api.projects.status = (path) => call('projects.status', async () => toStatus(await (await b.projects()).Status(path)));
  api.projects.close = () => call('projects.close', async () => (await b.projects()).Close());
  api.projects.forget = (path) => call('projects.forget', async () => (await b.projects()).Forget(path));
  // Создание копирует шаблон и запускает git init: длительность зависит от диска, срок ожидания не ставится.
  api.projects.create = (input) => call('projects.create', async () => toStatus(await (await b.projects()).Create(input)), false);
  api.projects.validateNew = (input) => call('projects.validateNew', async () => (await b.projects()).ValidateNew(input));
  api.projects.rename = (path, name) => call('projects.rename', async () => toStatus(await (await b.projects()).Rename(path, name)));
  api.projects.settings = (project) => call('projects.settings', async () => toSettings(await (await b.projects()).Settings(project)));
  api.projects.saveSettings = (project, settings) =>
    call('projects.saveSettings', async () =>
      toSettings(await (await b.projects()).SaveSettings(project, { ...settings, unset: undefinedPaths(settings.generation) }))
    );

  api.sources.view = (project) =>
    call('sources.view', async () => {
      const view = await (await b.sources()).View(project);
      // manifest — source/manifest.json как есть (json.RawMessage) или null для непригодной описи.
      return { ...view, manifest: view.manifest as SourceManifest | null };
    });
  api.sources.validate = (project, input) => call('sources.validate', async () => (await b.sources()).Validate(project, input));
  // Сохранение копирует трек и изображения: ожидание не ограничено, чтобы не показать ложную ошибку.
  api.sources.save = (project, input) => call('sources.save', async () => (await (await b.sources()).Save(project, input)) as SourceManifest, false);

  api.timing.view = (project) =>
    call('timing.view', async () => {
      const view = await (await b.timing()).View(project);
      // timing — plan/audio/timing.json как есть (json.RawMessage); как viewTiming, Go отдаёт null при непригодной структуре.
      return { ...view, timing: view.timing as TimingFile | null };
    });
  // Документ разметки передаётся как JSON без изменения неизвестных полей (json.RawMessage в Go).
  api.timing.save = (project, timing) => call('timing.save', async () => (await (await b.timing()).Save(project, timing)) as TimingFile);
  api.timing.vocalsView = (project) => call('timing.vocalsView', async () => toVocals(await (await b.timing()).VocalsView(project)));
  api.timing.downloadVocalModel = (model) => call('timing.downloadVocalModel', async () => toJob(await (await b.timing()).DownloadVocalModel(model)));
  api.timing.separateVocals = (project, model) => call('timing.separateVocals', async () => toJob(await (await b.timing()).SeparateVocals(project, model)));
  // Выбор и удаление пересчитывают SHA большого WAV и трека; корзина ОС может ждать дольше обычного вызова.
  api.timing.selectVocal = (project, id) => call('timing.selectVocal', async () => toVocals(await (await b.timing()).SelectVocal(project, id)), false);
  api.timing.deleteVocal = (project, id) => call('timing.deleteVocal', async () => toVocals(await (await b.timing()).DeleteVocal(project, id)), false);
  api.timing.songModelSetup = () => call('timing.songModelSetup', async () => (await b.timing()).SongModelSetup());
  api.timing.downloadSongModels = () => call('timing.downloadSongModels', async () => toJob(await (await b.timing()).DownloadSongModels()));
  api.timing.start = (project, options) => call('timing.start', async () => toJob(await (await b.timing()).Start(project, options)), false);
  api.timing.cancel = (id) => call('timing.cancel', async () => toJob(await (await b.timing()).Cancel(id)));

  // Документы сценария Go принимает и отдаёт как json.RawMessage (any в bindings): порядок ключей
  // и лишние поля сохраняются, а тип документа задаёт контракт. Закрытые строковые наборы
  // (готовность реестра, состояние плана, фаза) Go хранит строкой — сужается только тип.
  api.cast.view = (project) => call('cast.view', async () => (await b.cast()).View(project));
  api.cast.init = (project) => call('cast.init', async () => (await b.cast()).Init(project));
  api.cast.save = (project, cast) => call('cast.save', async () => (await b.cast()).Save(project, cast));

  api.scenario.status = (project) => call('scenario.status', async () => (await (await b.scenario()).Status(project)) as ScenarioStatus);
  api.scenario.view = (project) => call('scenario.view', async () => (await b.scenario()).View(project));
  api.scenario.saveTreatment = (project, treatment) => call('scenario.saveTreatment', async () => (await b.scenario()).SaveTreatment(project, treatment));
  api.scenario.validateTreatment = (project, treatment) =>
    call('scenario.validateTreatment', async () => (await b.scenario()).ValidateTreatment(project, treatment));
  api.scenario.saveScenes = (project, scenes, mode) => call('scenario.saveScenes', async () => (await b.scenario()).SaveScenes(project, scenes, mode));
  api.scenario.saveImpact = (project, scenes) =>
    call('scenario.saveImpact', async () => {
      const impact = await (await b.scenario()).SaveImpact(project, scenes);
      return { shots: impact.shots.map((shot) => ({ ...shot, state: shot.state as ScenarioImpactShot['state'] })) };
    });
  api.scenario.validateScenes = (project, scenes) => call('scenario.validateScenes', async () => (await b.scenario()).ValidateScenes(project, scenes));
  api.scenario.brief = (project, scenes, shot, phase) =>
    call('scenario.brief', async () => {
      const brief = await (await b.scenario()).Brief(project, scenes, shot, phase);
      return { ...brief, phase: brief.phase as BriefResult['phase'] };
    });

  // Инструменты Go выполняет в процессе приложения; ToolResult несёт код выхода, stdout и stderr
  // инструмента. Неизвестное имя — ошибка Go-сервиса своим текстом.
  api.tools.run = (project, name, args) => call('tools.run', async () => (await b.tools()).Run(project, name, args), false);

  // Проверки — задания общего менеджера. CheckId Go генерирует TS enum с теми же строками, поэтому
  // сужается только тип. Пробы стыков — задание build_review; список и удаление читают plan/batches.
  api.checks.list = () => call('checks.list', async () => (await (await b.checks()).List()).map((info) => ({ ...info, id: info.id as CheckId })));
  api.checks.run = (project, id, options) => call('checks.run', async () => toJob(await (await b.checks()).Run(project, id as checks.ID, options ?? {})));
  api.checks.runAll = (project, options) => call('checks.runAll', async () => toJob(await (await b.checks()).RunAll(project, options ?? {})));
  api.checks.updateViews = (project) => call('checks.updateViews', async () => toJob(await (await b.checks()).UpdateViews(project)));
  api.checks.buildReview = (project, options) => call('checks.buildReview', async () => toJob(await (await b.checks()).BuildReview(project, options)));
  api.checks.listReviews = (project) => call('checks.listReviews', async () => (await b.checks()).ListReviews(project));
  api.checks.removeReview = (project, path) => call('checks.removeReview', async () => (await b.checks()).RemoveReview(project, path));

  // Аниматик: сборка — задание update_scene_views + build_animatic; статус и вид медиа плана Go
  // отдаёт строками контракта, адаптер только сужает тип.
  // Журнал отправок: только чтение plan/prompt-log; Go отдаёт [] вместо null.
  api.promptLog.list = (project) => call('promptLog.list', async () => (await (await b.promptLog()).List(project)) as PromptLogSummary[]);
  api.promptLog.get = (project, id) => call('promptLog.get', async () => ((await (await b.promptLog()).Get(project, id)) ?? null) as PromptLogRecord | null);
  // История проекта в Git: сохранение и возврат могут идти долго (медиа через Git LFS), поэтому без срока.
  api.projectHistory.status = (project) =>
    call('projectHistory.status', async () => (await (await b.projectHistory()).Status(project)) as ProjectHistoryStatus);
  api.projectHistory.save = (project, message) =>
    call('projectHistory.save', async () => (await (await b.projectHistory()).Save(project, message)) as ProjectHistoryStatus, false);
  api.projectHistory.checkpoint = (project, operation) =>
    call('projectHistory.checkpoint', async () => (await b.projectHistory()).Checkpoint(project, operation), false);
  api.projectHistory.points = (project) => call('projectHistory.points', async () => (await (await b.projectHistory()).Points(project)) as ProjectPoint[]);
  api.projectHistory.restore = (project, point, section) =>
    call('projectHistory.restore', async () => (await (await b.projectHistory()).Restore(project, point, section)) as ProjectRestoreResult, false);
  api.projectHistory.compareScenario = (project, point) =>
    call('projectHistory.compareScenario', async () => (await (await b.projectHistory()).CompareScenario(project, point)) as ProjectScenarioComparison);
  api.animatic.view = (project) => call('animatic.view', async () => (await (await b.animatic()).View(project)) as AnimaticView);
  api.animatic.build = (project, planOnly) => call('animatic.build', async () => toJob(await (await b.animatic()).Build(project, planOnly ?? false)));
  api.animatic.fragment = (project, from, to) => call('animatic.fragment', async () => toJob(await (await b.animatic()).Fragment(project, from, to)));
  api.animatic.setStatus = (project, status) =>
    call('animatic.setStatus', async () => (await (await b.animatic()).SetStatus(project, status)) as AnimaticView, false);

  // Ручной монтаж. Черновик Go принимает и отдаёт сырым JSON (проверяет и нормализует
  // его сам), поэтому адаптер только сужает типы. Экспорт и применение
  // лишь ставят задание; выбор файла пробы ждёт пользователя и идёт без срока оболочки.
  api.montage = {
    view: (project) => call('montage.view', async () => (await (await b.montage()).View(project)) as unknown as MontageView),
    load: (project, id) => call('montage.load', async () => (await (await b.montage()).Load(project, id)) as unknown as MontageDraft),
    save: (project, draft, id) => call('montage.save', async () => (await b.montage()).Save(project, draft, id ?? null), false),
    remove: (project, id) => call('montage.remove', async () => (await b.montage()).Remove(project, id), false),
    export: (project, draft) =>
      call('montage.export', async () => {
        const { job, video } = await (await b.montage()).Export(project, draft);
        return { job: toJob(job), video };
      }),
    apply: (project, draft) => call('montage.apply', async () => toJob(await (await b.montage()).Apply(project, draft))),
    saveVideo: (project, video) => call('montage.saveVideo', async () => (await b.montage()).SaveVideo(project, video), false)
  };

  // Производные планы. Рецепт и вид проверяет Go, адаптер только
  // сужает типы и приводит задание к JobInfo контракта. Сборка и приёмка лишь ставят задание, но
  // сначала сверяют байты пробы, поэтому идут без срока оболочки.
  const derivedView = async (view: Promise<unknown>): Promise<DerivedShotView> => {
    const value = (await view) as DerivedShotView & { job: Parameters<typeof toJob>[0] | null };
    return { ...value, job: value.job ? toJob(value.job) : null };
  };
  // Обновление приложения. Go возвращает вид без путей; статус — строка UpdateStatus контракта.
  // Проверка, скачивание пакета в сотни мегабайт и установка идут без срока оболочки: у Go
  // свои сроки (20 с и 30 мин), а страница опрашивает view во время скачивания.
  const updateView = async (view: Promise<{ status: string }>): Promise<UpdateView> => (await view) as UpdateView;
  api.updates = {
    view: () => call('updates.view', async () => updateView((await b.updates()).View())),
    check: () => call('updates.check', async () => updateView((await b.updates()).Check()), false),
    download: () => call('updates.download', async () => updateView((await b.updates()).Download()), false),
    install: () => call('updates.install', async () => updateView((await b.updates()).Install()), false)
  };

  api.derivedShots = {
    view: (project, shot) => call('derivedShots.view', async () => derivedView((await b.derivedShots()).View(project, shot))),
    save: (project, shot, recipe) => call('derivedShots.save', async () => derivedView((await b.derivedShots()).Save(project, shot, recipe)), false),
    build: (project, shot, recipe) => call('derivedShots.build', async () => derivedView((await b.derivedShots()).Build(project, shot, recipe)), false),
    accept: (project, shot, previewId, resultToken, replace) =>
      call('derivedShots.accept', async () => derivedView((await b.derivedShots()).Accept(project, shot, previewId, resultToken, replace)), false)
  };

  // Сценарный проход агента. Go отдаёт статусы, проход и документы предложения строками и JSON
  // файлов проекта; адаптер только сужает типы. Записывающие действия ждут Go без срока оболочки:
  // start проверяет вход CLI, а apply гоняет проверки staging-копии и на клипе в 40 планов идёт
  // около минуты — 10 с срока показывали ошибку, хотя Go успешно публиковал сценарий.
  const workflow = async (view: Promise<scenarioworkflow.View>): Promise<ScenarioWorkflowView> => toWorkflowView(await view);
  api.scenarioWorkflow = {
    view: (project) => call('scenarioWorkflow.view', async () => workflow((await b.scenarioWorkflow()).View(project))),
    start: (input) => call('scenarioWorkflow.start', async () => workflow((await b.scenarioWorkflow()).Start(input)), false),
    apply: (project, id) => call('scenarioWorkflow.apply', async () => workflow((await b.scenarioWorkflow()).Apply(project, id)), false),
    approveCurrent: (project) => call('scenarioWorkflow.approveCurrent', async () => workflow((await b.scenarioWorkflow()).ApproveCurrent(project)), false),
    approveScenes: (project) => call('scenarioWorkflow.approveScenes', async () => workflow((await b.scenarioWorkflow()).ApproveScenes(project)), false),
    discard: (project, id) => call('scenarioWorkflow.discard', async () => workflow((await b.scenarioWorkflow()).Discard(project, id)), false)
  };

  api.jobs.list = () => call('jobs.list', async () => (await (await b.jobs()).List()).map(toJob));
  api.jobs.get = (id) =>
    call('jobs.get', async () => {
      const info = await (await b.jobs()).Get(id);
      return info === null ? null : toJob(info);
    });
  api.jobs.copyText = (id) => call('jobs.copyText', async () => (await b.jobs()).CopyText(id));

  // Диагностика, аккаунт, модели и запуск вызывают CLI (до 10 с на команду): срок ожидания оболочки
  // не ставится, чтобы медленный CLI не показал ложную ошибку связи. Отказ Go приходит текстом
  // «[КОД] причина».
  api.ai.access = (project) =>
    call(
      'ai.access',
      async () => {
        const access = await (await b.ai()).Access(project);
        return { ...access, agent: { ...access.agent, provider: access.agent.provider as AiAccess['agent']['provider'] } } satisfies AiAccess;
      },
      false
    );
  api.agents.getSettings = () => call('agents.getSettings', async () => toAgentSettingsOrNull(await (await b.agents()).GetSettings()));
  api.agents.getProviderSettings = (provider) =>
    call('agents.getProviderSettings', async () => toAgentSettingsOrNull(await (await b.agents()).GetProviderSettings(provider)));
  api.agents.saveProviderSettings = (settings) =>
    call('agents.saveProviderSettings', async () => toAgentSettings(await (await b.agents()).SaveProviderSettings(settings)));
  api.agents.saveSettings = (settings) => call('agents.saveSettings', async () => toAgentSettingsOrNull(await (await b.agents()).SaveSettings(settings)));
  api.agents.check = (settings) => call('agents.check', async () => toAgentCheck(await (await b.agents()).Check(settings)), false);
  api.agents.account = (settings) =>
    call(
      'agents.account',
      async () => {
        const account = await (await b.agents()).Account(settings);
        return { ...account, provider: account.provider as AgentSettings['provider'], diagnostic: toAgentCheck(account.diagnostic) };
      },
      false
    );
  api.agents.models = (settings) => call('agents.models', async () => (await b.agents()).Models(settings), false);
  api.agents.start = (input) => call('agents.start', async () => toAgentJob(await (await b.agents()).Start(input)), false);
  api.agents.cancel = (id) => call('agents.cancel', async () => toAgentJob(await (await b.agents()).Cancel(id)));
  api.agents.get = (id) =>
    call('agents.get', async () => {
      const job = await (await b.agents()).Get(id);
      return job === null ? null : toAgentJob(job);
    });
  api.agents.list = (project) => call('agents.list', async () => (await (await b.agents()).List(project ?? null)).map(toAgentJob));
  // Событие несёт AgentEvent контракта как есть (agents.Event в Go).
  api.agents.onEvent = (listener) => subscribe<AgentEvent>(b.events, 'agents:event', listener);

  // Запуск сначала проверяет доступ к агенту (вызов CLI до 10 с), поэтому без срока ожидания
  // оболочки; подготовка кадров и задание агента идут в Go в фоне, состояние читается через view.
  api.videoReview.view = (project, packageDir) => call('videoReview.view', async () => toVideoReview(await (await b.videoReview()).View(project, packageDir)));
  api.videoReview.start = (project, packageDir) =>
    call('videoReview.start', async () => toVideoReview(await (await b.videoReview()).Start(project, packageDir)), false);
  api.videoReview.cancel = (project, packageDir) =>
    call('videoReview.cancel', async () => toVideoReview(await (await b.videoReview()).Cancel(project, packageDir)));

  // Обложка и референсы: создание, подготовка и запуск сначала проверяют доступ к провайдеру
  // изображений (диагностика до 10 с), подготовка ждёт каталог моделей и цену, поэтому без срока
  // ожидания оболочки; генерация идёт в Go в фоне, состояние читается через view. Закрытие ждёт
  // остановки работы сессии.
  for (const prefix of ['cover', 'referenceImages'] as const) {
    const service = prefix === 'cover' ? b.cover : b.referenceImages;
    const group = api[prefix];
    group.inspect = (input) => call(`${prefix}.inspect`, async () => (await service()).Inspect(toGenerationInput(input)));
    group.create = (project, prompt, input) =>
      call(`${prefix}.create`, async () => toCoverSession(await (await service()).Create(project, prompt, input ? toGenerationInput(input) : null)), false);
    group.prepare = (id) => call(`${prefix}.prepare`, async () => toCoverSession(await (await service()).Prepare(id)), false);
    group.generate = (id, requestSha, approval) =>
      call(`${prefix}.generate`, async () => toCoverSession(await (await service()).Generate(id, requestSha, approval)), false);
    group.view = (id) => call(`${prefix}.view`, async () => toCoverSession(await (await service()).View(id)));
    group.close = (id) => call(`${prefix}.close`, async () => (await service()).Close(id), false);
  }
  api.cover.accept = (id, crop) => call('cover.accept', async () => (await b.cover()).Accept(id, crop));
  api.referenceImages.accept = (id) => call('referenceImages.accept', async () => (await b.referenceImages()).Accept(id));
  api.referenceImages.attach = (id, entityId) => call('referenceImages.attach', async () => (await b.referenceImages()).Attach(id, entityId));
  api.referenceImages.context = (project, drafts) => call('referenceImages.context', async () => (await b.referenceImages()).Context(project, drafts ?? null));

  // Строки «Среды»: события environment:progress относятся к вызову по requestId; подписка
  // создаётся до вызова и живёт только до его окончания, чужие и запоздалые события отбрасываются.
  // Проверка входа и вход ждут сервис провайдера (до 135 с и до 5,5 мин), поэтому без срока
  // ожидания оболочки.
  api.environment.check = (onProgress) =>
    call(
      'environment.check',
      async () => {
        const requestId = `${Date.now()}-${++environmentRequest}`;
        let off: (() => void) | undefined;
        if (onProgress) {
          const source = await b.events();
          off = source.on('environment:progress', (event) => {
            const value = event.data as { requestId: string; check: mediaapi.EnvironmentCheck };
            if (value.requestId === requestId) onProgress(toEnvironmentCheck(value.check));
          });
        }
        try {
          return (await (await b.environment()).Check(requestId)).map(toEnvironmentCheck);
        } finally {
          off?.();
        }
      },
      false
    );
  api.environment.providerAuth = (provider) =>
    call('environment.providerAuth', async () => toProviderAuth(await (await b.environment()).ProviderAuth(provider)), false);
  api.environment.loginProvider = (provider) => call('environment.loginProvider', async () => (await b.environment()).LoginProvider(provider), false);
  api.environment.cancelLogin = (provider) => call('environment.cancelLogin', async () => (await b.environment()).CancelLogin(provider));
  api.environment.onLoginUrl = (listener) => subscribe<{ provider: string; url: string }>(b.events, 'environment:loginUrl', listener);
  // Каталог моделей ждёт сервис провайдера до 35 с: срок ожидания оболочки не ставится.
  api.media.capabilities = (project, kind, provider) =>
    call('media.capabilities', async () => toMediaCapabilities(await (await b.media()).Capabilities(project, kind, provider)), false);

  // Производство. Документы пакета (workflow.json, timing, решения, предложения) Go передаёт как
  // есть сырыми JSON-значениями (json.RawMessage → any в bindings), поэтому ответ сужается до
  // типов контракта без проверки — их форму задаёт файл проекта. Отправка,
  // получение, приёмка и повтор ждут оценку и сервис провайдера: без срока ожидания оболочки.
  const production = async () => b.production();
  api.production.view = (project) => call('production.view', async () => (await (await production()).View(project)) as unknown as ProductionView);
  api.production.decide = (project, packageDir, verdict, note, decisionToken, noteScope) =>
    call('production.decide', async () => (await production()).Decide(project, packageDir, verdict, note ?? '', decisionToken ?? '', noteScope ?? ''), false);
  api.production.reopenFrame = (project, packageDir, frame, note, noteScope) =>
    call('production.reopenFrame', async () => (await production()).ReopenFrame(project, packageDir, frame, note, noteScope), false);
  api.production.reopenPrompt = (project, packageDir, note) =>
    call('production.reopenPrompt', async () => (await production()).ReopenPrompt(project, packageDir, note), false);
  api.production.keepPackageForScene = (project, packageDir) =>
    call('production.keepPackageForScene', async () => (await production()).KeepPackageForScene(project, packageDir));
  api.production.addKeyframeNote = (project, packageDir, frame, note, noteScope) =>
    call('production.addKeyframeNote', async () => (await production()).AddKeyframeNote(project, packageDir, frame, note, noteScope));
  api.production.setKeyframeNote = (project, packageDir, id, active) =>
    call('production.setKeyframeNote', async () => (await production()).SetKeyframeNote(project, packageDir, id, active));
  api.production.quote = (project, packageDir, expectedSha, decisionToken) =>
    call(
      'production.quote',
      async () => {
        const quote = await (await production()).Quote(project, packageDir, expectedSha, decisionToken ?? '');
        return { ...quote, verdict: quote.verdict as ProductionQuote['verdict'] };
      },
      false
    );
  api.production.submit = (project, packageDir, expectedSha, decisionToken, quoteToken, unknownCostConsentToken) =>
    call(
      'production.submit',
      async () =>
        toJob(await (await production()).Submit(project, packageDir, expectedSha, decisionToken ?? '', quoteToken ?? '', unknownCostConsentToken ?? '')),
      false
    );
  api.production.resume = (project, packageDir) => call('production.resume', async () => toJob(await (await production()).Resume(project, packageDir)), false);
  api.production.attachResult = (project, packageDir, files) =>
    call('production.attachResult', async () => toJob(await (await production()).AttachResult(project, packageDir, files)), false);
  api.production.attachManual = (project, packageDir, result) =>
    call('production.attachManual', async () => toJob(await (await production()).AttachManual(project, packageDir, result)), false);
  api.production.replaceManual = (project, packageDir, result) =>
    call('production.replaceManual', async () => toJob(await (await production()).ReplaceManual(project, packageDir, result)), false);
  api.production.attachOwnVideo = (project, shot, result) =>
    call(
      'production.attachOwnVideo',
      async () => {
        const started = await (await production()).AttachOwnVideo(project, shot, result);
        return { packageDir: started.packageDir, job: toJob(started.job) };
      },
      false
    );
  api.production.markNotCreated = (project, packageDir) =>
    call('production.markNotCreated', async () => (await production()).MarkNotCreated(project, packageDir), false);
  api.production.selectImage = (project, packageDir, index, expectedResultToken) =>
    call('production.selectImage', async () => (await production()).SelectImage(project, packageDir, index, expectedResultToken), false);
  api.production.regenerate = (project, shot) => call('production.regenerate', async () => toJob(await (await production()).Regenerate(project, shot)), false);
  api.production.accept = (project, shot, packageDir, options) =>
    call('production.accept', async () => toJob(await (await production()).Accept(project, shot, packageDir, options)), false);
  // Сводка пакета — задание contact_sheet; срез речи режет cut_speech (до минуты на длинной песне),
  // поэтому срок ожидания оболочки не ставится.
  api.production.contactSheet = (project, packageDir) =>
    call('production.contactSheet', async () => toJob(await (await production()).ContactSheet(project, packageDir)), false);
  api.production.prepareSpeech = (project, packageDir, bounds) =>
    call(
      'production.prepareSpeech',
      async () => (await (await production()).PrepareSpeech(project, packageDir, bounds ?? null)) as unknown as PackageView,
      false
    );
  api.production.park = (project, packageDir) => call('production.park', async () => (await production()).Park(project, packageDir));
  api.production.spend = (project, shot) => call('production.spend', async () => (await (await production()).Spend(project, shot)) as ShotSpend);
  api.production.projectSpend = (project) => call('production.projectSpend', async () => (await (await production()).ProjectSpend(project)) as ProjectSpend);
  api.production.setSpendAmount = (project, ref, amount, unit) =>
    call('production.setSpendAmount', async () => (await production()).SetSpendAmount(project, ref, amount, unit), true);
  api.production.priceAccepted = (project, shot, amount, unit) =>
    call('production.priceAccepted', async () => (await production()).PriceAccepted(project, shot, amount, unit), true);
  api.production.resultMedia = (project, packageDir) =>
    call('production.resultMedia', async () => (await (await production()).ResultMedia(project, packageDir)) as ResultMedia | null);
  api.production.acceptedKit = (project, shot) =>
    call('production.acceptedKit', async () => ((await (await production()).AcceptedKit(project, shot)) ?? null) as unknown as AcceptedKit | null);
  api.production.speechPlan = (project, shot, packageDir) =>
    call('production.speechPlan', async () => (await (await production()).SpeechPlan(project, shot, packageDir ?? '')) as unknown as SpeechPlan);
  api.production.reopenQuestion = (project, packageDir) =>
    call('production.reopenQuestion', async () => (await production()).ReopenQuestion(project, packageDir));
  api.production.discardAttempt = (project, packageDir) =>
    call('production.discardAttempt', async () => (await production()).DiscardAttempt(project, packageDir));
  api.production.exportBundle = (project, options) =>
    call('production.exportBundle', async () => toJob(await (await production()).ExportBundle(project, options)), false);
  api.production.listBundles = (project) => call('production.listBundles', async () => (await production()).ListBundles(project));
  api.production.removeBundle = (project, path) => call('production.removeBundle', async () => (await production()).RemoveBundle(project, path));
  // Проход агента производства. start ждёт врезки непрерывности и каталог моделей провайдера
  // (до 35 с), поэтому срок ожидания оболочки не ставится; пакет "" — новая подготовка.
  const productionWorkflow = async (view: Promise<productionworkflow.View>): Promise<ProductionWorkflowView> => toProductionWorkflowView(await view);
  api.productionWorkflow.view = (project, shot, packageDir) =>
    call('productionWorkflow.view', async () => productionWorkflow((await b.productionWorkflow()).View(project, shot, packageDir ?? '')));
  api.productionWorkflow.start = (input) =>
    call('productionWorkflow.start', async () => productionWorkflow((await b.productionWorkflow()).Start(input)), false);
  // apply запускает shot_workflow и для запроса — каталог моделей и media_request prepare, поэтому
  // тоже без срока ожидания оболочки.
  api.productionWorkflow.apply = (project, shot, packageDir, id) =>
    call('productionWorkflow.apply', async () => productionWorkflow((await b.productionWorkflow()).Apply(project, shot, packageDir ?? '', id)), false);
  api.productionWorkflow.discard = (project, shot, packageDir, id) =>
    call('productionWorkflow.discard', async () => productionWorkflow((await b.productionWorkflow()).Discard(project, shot, packageDir ?? '', id)));
  // Платная опора ждёт каталог моделей и подготовку запроса провайдера, поэтому срока ожидания нет.
  api.productionWorkflow.generateFrames = (project, shot, packageDir) =>
    call('productionWorkflow.generateFrames', async () => productionWorkflow((await b.productionWorkflow()).GenerateFrames(project, shot, packageDir)), false);
  api.productionWorkflow.importFrames = (project, shot, packageDir, images) =>
    call('productionWorkflow.importFrames', async () => productionWorkflow((await b.productionWorkflow()).ImportFrames(project, shot, packageDir, images)));
  api.productionWorkflow.buildManual = (project, shot, packageDir) =>
    call('productionWorkflow.buildManual', async () => productionWorkflow((await b.productionWorkflow()).BuildManual(project, shot, packageDir)));
  api.productionWorkflow.setGenerationMethod = (project, shot, packageDir, method) =>
    call('productionWorkflow.setGenerationMethod', async () =>
      productionWorkflow((await b.productionWorkflow()).SetGenerationMethod(project, shot, packageDir, method))
    );
  api.productionWorkflow.saveOwn = (input) =>
    call('productionWorkflow.saveOwn', async () => productionWorkflow((await b.productionWorkflow()).SaveOwn(input)), false);
  api.productionWorkflow.referenceImages = (project, shot) =>
    call('productionWorkflow.referenceImages', async () => (await b.productionWorkflow()).ReferenceImages(project, shot));
  api.dashboard.view = (project) => call('dashboard.view', async () => (await (await b.dashboard()).View(project)) as unknown as DashboardView);

  api.notifications.onOpen = (listener) => subscribe<NotificationTarget>(b.events, 'notifications:open', listener);

  api.components = {
    state: () => call('components.state', async () => (await b.components()).State()),
    connect: (component) =>
      call(
        'components.connect',
        async () => {
          const path = await (await b.native()).PickComponentFile(component);
          return path === null ? null : (await b.components()).Connect(component, path);
        },
        false
      ),
    download: (components) => call('components.download', async () => (await b.components()).Download(components), false),
    configure: (selection) => call('components.configure', async () => (await b.components()).Configure(selection)),
    check: (operations, force) => call('components.check', async () => (await b.components()).Check(operations, force), false),
    cancel: () => call('components.cancel', async () => (await b.components()).Cancel()),
    catalog: () => call('components.catalog', async () => (await b.components()).Catalog()),
    installation: () => call('components.installation', async () => (await b.components()).Installation()),
    install: (request) => call('components.install', async () => (await b.components()).Install(request), false),
    cancelInstall: () => call('components.cancelInstall', async () => (await b.components()).CancelInstall()),
    chooseDirectory: (component) =>
      call(
        'components.chooseDirectory',
        async () => (await b.native()).PickFolder({ title: componentFolderTitle(component), filters: [], multiple: false }),
        false
      ),
    chooseFile: (component) =>
      call(
        'components.chooseFile',
        async () => {
          const title = componentTexts.selectOfflineFile(componentTexts.names[component] ?? component);
          const [path] = await (await b.native()).PickFiles({ title, filters: [], multiple: false });
          return path ?? null;
        },
        false
      )
  };
  return api;
}

/** Единственная установка window.api; код UI не получает файловую систему или возможность запускать процессы. */
export function installApi(bindings: Bindings = nativeBindings): void {
  window.api = createApi(bindings);
}

/** Подтверждает React mount после State; обычный запуск ничего не закрывает, smoke завершает нативную проверку. */
export function signalFrontendReady(bindings: Bindings = nativeBindings): Promise<void> {
  return call('frontendReady', async () => (await bindings.app()).FrontendReady());
}

declare global {
  interface Window {
    api: Api;
  }
}
