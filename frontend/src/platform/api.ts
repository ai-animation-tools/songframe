/**
 * Единственная реализация window.api (D-027): каждый метод контракта shared/api.ts вызывает
 * сгенерированный binding Wails. Ответы Go не перепроверяются вручную — соответствие типов
 * bindings ↔ shared/types проверяет typecheck, а отсутствие null в коллекциях гарантирует
 * wire.Fill на стороне Go. Методы, ещё не перенесённые в Go, явно отвергаются с кодом UNAVAILABLE.
 */
import type { Api } from '@shared/api';
import type {
  AppState,
  BriefResult,
  CheckId,
  DashboardView,
  EnvironmentCheck,
  GenerationSettings,
  JobInfo,
  JobStepInfo,
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
import type * as status from '../../bindings/songframe-go/internal/status/models';
import type * as jobs from '../../bindings/songframe-go/internal/jobs/models';
import type * as checks from '../../bindings/songframe-go/internal/checks/models';
import type * as songtiming from '../../bindings/songframe-go/internal/songtiming/models';
import type * as agentModels from '../../bindings/songframe-go/internal/agents/models';
import type { AgentCheckResult, AgentDiagnosticCode, AgentEvent, AgentJob, AgentSettings } from '@shared/agents';
import type * as videoReviewModels from '../../bindings/songframe-go/internal/videoreview/models';
import type { VideoReviewFinding, VideoReviewView } from '@shared/video-review';
import type * as covergen from '../../bindings/songframe-go/internal/covergen/models';
import type * as referenceimage from '../../bindings/songframe-go/internal/referenceimage/models';
import type { CoverGenerationSession } from '@shared/cover-generation';
import type { ReferenceImageGenerationInput } from '@shared/reference-image-generation';
import type { AiAccess } from '@shared/ai-access';
import type * as scenarioworkflow from '../../bindings/songframe-go/internal/scenarioworkflow/models';
import type { ScenarioDocuments, ScenarioProposal, ScenarioWorkflowView } from '@shared/scenario-workflow';
import type * as productionworkflow from '../../bindings/songframe-go/internal/productionworkflow/models';
import type { ProductionFramePrompt, ProductionProposal, ProductionWorkflowView } from '@shared/production-workflow';
import type { VocalModelId, VocalPreparationView } from '@shared/vocals';
import type { NotificationTarget } from '@shared/notifications';
import type * as mediaapi from '../../bindings/songframe-go/internal/mediaapi/models';
import type { MediaCapabilities, MediaKind, ProviderAuth } from '@shared/media-providers';
import { componentTexts } from '@shared/texts/component-manager';
import { platformTexts } from '@shared/texts/platform';
import { unavailableApi, type ApiMethod } from './unavailable-api';
import { fileUrl } from './file-url';

export type { ApiMethod } from './unavailable-api';

/** Ошибка сохраняет технический код и метод для диагностики, не превращая отказ в успешную пустую выдачу. */
export class ApiError extends Error {
  constructor(
    public readonly code: 'UNAVAILABLE' | 'TIMEOUT' | 'CONNECTION_FAILED' | 'SERVICE_FAILED',
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
  app: () => Promise<typeof import('../../bindings/songframe-go/internal/app/appservice')>;
  shell: () => Promise<typeof import('../../bindings/songframe-go/internal/app/shellservice')>;
  native: () => Promise<typeof import('../../bindings/songframe-go/internal/app/nativeservice')>;
  components: () => Promise<typeof import('../../bindings/songframe-go/internal/app/componentsservice')>;
  jobs: () => Promise<typeof import('../../bindings/songframe-go/internal/app/jobsservice')>;
  projects: () => Promise<typeof import('../../bindings/songframe-go/internal/app/projectservice')>;
  timing: () => Promise<typeof import('../../bindings/songframe-go/internal/app/timingservice')>;
  sources: () => Promise<typeof import('../../bindings/songframe-go/internal/app/sourcesservice')>;
  cast: () => Promise<typeof import('../../bindings/songframe-go/internal/app/castservice')>;
  scenario: () => Promise<typeof import('../../bindings/songframe-go/internal/app/scenarioservice')>;
  tools: () => Promise<typeof import('../../bindings/songframe-go/internal/app/toolsservice')>;
  checks: () => Promise<typeof import('../../bindings/songframe-go/internal/app/checksservice')>;
  agents: () => Promise<typeof import('../../bindings/songframe-go/internal/app/agentsservice')>;
  ai: () => Promise<typeof import('../../bindings/songframe-go/internal/app/aiservice')>;
  scenarioWorkflow: () => Promise<typeof import('../../bindings/songframe-go/internal/app/scenarioworkflowservice')>;
  productionWorkflow: () => Promise<typeof import('../../bindings/songframe-go/internal/app/productionworkflowservice')>;
  videoReview: () => Promise<typeof import('../../bindings/songframe-go/internal/app/videoreviewservice')>;
  cover: () => Promise<typeof import('../../bindings/songframe-go/internal/app/coverservice')>;
  referenceImages: () => Promise<typeof import('../../bindings/songframe-go/internal/app/referenceimagesservice')>;
  environment: () => Promise<typeof import('../../bindings/songframe-go/internal/app/environmentservice')>;
  media: () => Promise<typeof import('../../bindings/songframe-go/internal/app/mediaservice')>;
  production: () => Promise<typeof import('../../bindings/songframe-go/internal/app/productionservice')>;
  dashboard: () => Promise<typeof import('../../bindings/songframe-go/internal/app/dashboardservice')>;
  events: EventSource;
}

export const nativeBindings: Bindings = {
  app: () => import('../../bindings/songframe-go/internal/app/appservice'),
  shell: () => import('../../bindings/songframe-go/internal/app/shellservice'),
  native: () => import('../../bindings/songframe-go/internal/app/nativeservice'),
  components: () => import('../../bindings/songframe-go/internal/app/componentsservice'),
  jobs: () => import('../../bindings/songframe-go/internal/app/jobsservice'),
  projects: () => import('../../bindings/songframe-go/internal/app/projectservice'),
  timing: () => import('../../bindings/songframe-go/internal/app/timingservice'),
  sources: () => import('../../bindings/songframe-go/internal/app/sourcesservice'),
  cast: () => import('../../bindings/songframe-go/internal/app/castservice'),
  scenario: () => import('../../bindings/songframe-go/internal/app/scenarioservice'),
  tools: () => import('../../bindings/songframe-go/internal/app/toolsservice'),
  checks: () => import('../../bindings/songframe-go/internal/app/checksservice'),
  agents: () => import('../../bindings/songframe-go/internal/app/agentsservice'),
  ai: () => import('../../bindings/songframe-go/internal/app/aiservice'),
  scenarioWorkflow: () => import('../../bindings/songframe-go/internal/app/scenarioworkflowservice'),
  productionWorkflow: () => import('../../bindings/songframe-go/internal/app/productionworkflowservice'),
  videoReview: () => import('../../bindings/songframe-go/internal/app/videoreviewservice'),
  cover: () => import('../../bindings/songframe-go/internal/app/coverservice'),
  referenceImages: () => import('../../bindings/songframe-go/internal/app/referenceimagesservice'),
  environment: () => import('../../bindings/songframe-go/internal/app/environmentservice'),
  media: () => import('../../bindings/songframe-go/internal/app/mediaservice'),
  production: () => import('../../bindings/songframe-go/internal/app/productionservice'),
  dashboard: () => import('../../bindings/songframe-go/internal/app/dashboardservice'),
  events: async () => {
    const { Events } = await import('@wailsio/runtime');
    return { on: Events.On };
  }
};

/** Методы с реализацией в Go. Всё остальное в контракте — «ещё не перенесено» с понятной причиной. */
const IMPLEMENTED = new Set<ApiMethod>([
  'app.state',
  'dialog.pickFolder',
  'dialog.pickFiles',
  'shell.openPath',
  'shell.readText',
  'shell.fileUrl',
  'shell.onFilesDropped',
  'diagnostics.reportRendererError',
  'diagnostics.crashNotice',
  'diagnostics.saveReport',
  'notifications.onOpen',
  'projects.open',
  'projects.create',
  'projects.validateNew',
  'projects.status',
  'projects.rename',
  'projects.close',
  'projects.forget',
  'projects.settings',
  'projects.saveSettings',
  'sources.view',
  'sources.validate',
  'sources.save',
  'timing.view',
  'cast.view',
  'cast.init',
  'cast.save',
  'scenario.status',
  'scenario.view',
  'scenario.saveTreatment',
  'scenario.validateTreatment',
  'scenario.saveScenes',
  'scenario.saveImpact',
  'scenario.validateScenes',
  'scenario.brief',
  'tools.run',
  'checks.list',
  'checks.run',
  'checks.runAll',
  'checks.updateViews',
  'scenarioWorkflow.view',
  'scenarioWorkflow.start',
  'scenarioWorkflow.apply',
  'scenarioWorkflow.approveCurrent',
  'scenarioWorkflow.approveScenes',
  'scenarioWorkflow.discard',
  'timing.save',
  'timing.vocalsView',
  'timing.downloadVocalModel',
  'timing.separateVocals',
  'timing.selectVocal',
  'timing.deleteVocal',
  'timing.songModelSetup',
  'timing.downloadSongModels',
  'timing.start',
  'timing.cancel',
  'jobs.list',
  'jobs.get',
  'jobs.copyText',
  'components.state',
  'components.connect',
  'components.download',
  'components.configure',
  'components.check',
  'components.cancel',
  'components.catalog',
  'components.installation',
  'components.install',
  'components.cancelInstall',
  'components.chooseDirectory',
  'components.chooseFile',
  'ai.access',
  'agents.getSettings',
  'agents.getProviderSettings',
  'agents.saveProviderSettings',
  'agents.saveSettings',
  'agents.check',
  'agents.account',
  'agents.models',
  'agents.start',
  'agents.cancel',
  'agents.get',
  'agents.list',
  'agents.onEvent',
  'environment.check',
  'environment.loginProvider',
  'environment.cancelLogin',
  'environment.onLoginUrl',
  'environment.providerAuth',
  'media.capabilities',
  'videoReview.view',
  'videoReview.start',
  'videoReview.cancel',
  'cover.inspect',
  'cover.create',
  'cover.prepare',
  'cover.generate',
  'cover.view',
  'cover.accept',
  'cover.close',
  'referenceImages.inspect',
  'referenceImages.context',
  'referenceImages.create',
  'referenceImages.prepare',
  'referenceImages.generate',
  'referenceImages.view',
  'referenceImages.accept',
  'referenceImages.attach',
  'referenceImages.close',
  // Производство. prepareSpeech, contactSheet и exportBundle требуют FFmpeg-конвейера этапа 46.
  'production.view',
  'production.decide',
  'production.reopenFrame',
  'production.keepPackageForScene',
  'production.setKeyframeNote',
  'production.quote',
  'production.submit',
  'production.resume',
  'production.attachResult',
  'production.markNotCreated',
  'production.selectImage',
  'production.regenerate',
  'production.accept',
  'production.park',
  'production.speechPlan',
  'production.reopenQuestion',
  'production.discardAttempt',
  'production.listBundles',
  'production.removeBundle',
  // Проход агента производства. apply переносит этап 45g.2, generateFrames и importFrames — 45g.3.
  'productionWorkflow.view',
  'productionWorkflow.start',
  'productionWorkflow.discard',
  'dashboard.view'
]);

/** Доступность принадлежит адаптеру, поэтому UI не повторяет собственный список готовых Go-операций. */
export function methodAvailability(method: ApiMethod): { available: boolean; reason: string | null } {
  return IMPLEMENTED.has(method) ? { available: true, reason: null } : { available: false, reason: platformTexts.unavailable };
}

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
 * документы предложения — JSON { cast, treatment, scenes } оригинала. Необязательное message
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
  return { ...view, proposal: next, job: job ? (job as unknown as AgentJob) : null };
}

/**
 * Вид прохода агента производства: план опор, ID опор и предложение — документы пакета и
 * локальной записи, которые Go передаёт сырыми JSON-значениями; провайдеры — значения настроек
 * проекта как есть (поле отсутствует без значения). Адаптер только сужает типы.
 */
function toProductionWorkflowView({
  imageProvider,
  videoProvider,
  framePrompts,
  nextFrame,
  approvedFrameIds,
  proposal,
  job,
  ...view
}: productionworkflow.View): ProductionWorkflowView {
  return {
    ...view,
    ...(imageProvider === undefined ? {} : { imageProvider: imageProvider as string }),
    ...(videoProvider === undefined ? {} : { videoProvider: videoProvider as string }),
    framePrompts: framePrompts as ProductionFramePrompt[],
    nextFrame: nextFrame as string | null,
    approvedFrameIds: approvedFrameIds as string[],
    proposal: proposal as ProductionProposal | null,
    job: job === null ? null : toAgentJob(job)
  };
}

/** ID моделей вокала — закрытый набор KNOWN_VOCAL_MODELS; Go хранит их строкой. */
const toVocals = (view: songtiming.VocalPreparationView): VocalPreparationView => ({
  ...view,
  models: view.models.map((model) => ({ ...model, id: model.id as VocalModelId })),
  results: view.results.map((result) => ({ ...result, modelId: result.modelId as VocalModelId }))
});

/** Состояние проекта — закрытый набор строк computeStatus; Go хранит его строкой. */
const toStatus = (value: status.ProjectStatus): ProjectStatus => ({ ...value, state: value.state as ProjectStatus['state'] });

/**
 * Пути ключей generation со значением undefined. Electron IPC передавал такие ключи, и запись
 * удаляла поле (сброс модели или разрешения); JSON-мост их теряет, поэтому Go получает их списком.
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
  const fail = (method: ApiMethod): never => {
    throw new ApiError('UNAVAILABLE', method, platformTexts.unavailable);
  };
  const api = unavailableApi(async (method) => fail(method), fail);
  let fileBase: string | null = null;

  api.app.state = () =>
    call('app.state', async () => {
      if (fileBase === null) fileBase = await (await b.shell()).FileBase();
      const state = await (await b.app()).State();
      // Платформа — закрытый набор значений Go (runtime.GOOS, Windows → win32); тип строки не сужается генератором.
      return { ...state, platform: state.platform as AppState['platform'] } satisfies AppState;
    });

  api.dialog.pickFolder = (options) => call('dialog.pickFolder', async () => (await b.native()).PickFolder(pickOptions(options)), false);
  api.dialog.pickFiles = (options) => call('dialog.pickFiles', async () => (await b.native()).PickFiles(pickOptions(options)), false);

  api.shell.openPath = (path) => call('shell.openPath', async () => (await b.shell()).OpenPath(path));
  api.shell.readText = (path) => call('shell.readText', async () => (await b.shell()).ReadText(path));
  api.shell.fileUrl = (path) => {
    if (fileBase === null) throw new ApiError('UNAVAILABLE', 'shell.fileUrl', platformTexts.connectionFailed);
    return fileUrl(fileBase, path);
  };
  api.shell.onFilesDropped = (listener) =>
    subscribe<{ targetID: string; paths: string[] }>(b.events, 'native:files-dropped', (drop) => listener({ targetId: drop.targetID, paths: drop.paths }));

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

  // Перенесённые инструменты Go выполняет в процессе приложения; ToolResult повторяет код, stdout
  // и stderr процесса Python оригинала. Неперенесённое имя — ошибка Go-сервиса своим текстом.
  api.tools.run = (project, name, args) => call('tools.run', async () => (await b.tools()).Run(project, name, args), false);

  // Проверки — задания общего менеджера. CheckId Go генерирует TS enum с теми же строками, поэтому
  // сужается только тип. Пробы стыков (buildReview, listReviews, removeReview) ещё не перенесены.
  api.checks.list = () => call('checks.list', async () => (await (await b.checks()).List()).map((info) => ({ ...info, id: info.id as CheckId })));
  api.checks.run = (project, id, options) => call('checks.run', async () => toJob(await (await b.checks()).Run(project, id as checks.ID, options ?? {})));
  api.checks.runAll = (project, options) => call('checks.runAll', async () => toJob(await (await b.checks()).RunAll(project, options ?? {})));
  api.checks.updateViews = (project) => call('checks.updateViews', async () => toJob(await (await b.checks()).UpdateViews(project)));

  // Сценарный проход агента. Go отдаёт статусы, проход и документы предложения строками и JSON
  // оригинала; адаптер только сужает типы. Записывающие действия ждут Go без срока оболочки:
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
  // «[КОД] причина», как у agents:start в Electron.
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
  // типов контракта без проверки — их форму задаёт файл проекта, как в оригинале. Отправка,
  // получение, приёмка и повтор ждут оценку и сервис провайдера: без срока ожидания оболочки.
  const production = async () => b.production();
  api.production.view = (project) => call('production.view', async () => (await (await production()).View(project)) as unknown as ProductionView);
  api.production.decide = (project, packageDir, verdict, note, decisionToken, noteScope) =>
    call('production.decide', async () => (await production()).Decide(project, packageDir, verdict, note ?? '', decisionToken ?? '', noteScope ?? ''), false);
  api.production.reopenFrame = (project, packageDir, frame, note, noteScope) =>
    call('production.reopenFrame', async () => (await production()).ReopenFrame(project, packageDir, frame, note, noteScope), false);
  api.production.keepPackageForScene = (project, packageDir) =>
    call('production.keepPackageForScene', async () => (await production()).KeepPackageForScene(project, packageDir));
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
  api.production.markNotCreated = (project, packageDir) =>
    call('production.markNotCreated', async () => (await production()).MarkNotCreated(project, packageDir), false);
  api.production.selectImage = (project, packageDir, index, expectedResultToken) =>
    call('production.selectImage', async () => (await production()).SelectImage(project, packageDir, index, expectedResultToken), false);
  api.production.regenerate = (project, shot) => call('production.regenerate', async () => toJob(await (await production()).Regenerate(project, shot)), false);
  api.production.accept = (project, shot, packageDir, options) =>
    call('production.accept', async () => toJob(await (await production()).Accept(project, shot, packageDir, options)), false);
  api.production.park = (project, packageDir) => call('production.park', async () => (await production()).Park(project, packageDir));
  api.production.speechPlan = (project, shot, packageDir) =>
    call('production.speechPlan', async () => (await (await production()).SpeechPlan(project, shot, packageDir ?? '')) as unknown as SpeechPlan);
  api.production.reopenQuestion = (project, packageDir) =>
    call('production.reopenQuestion', async () => (await production()).ReopenQuestion(project, packageDir));
  api.production.discardAttempt = (project, packageDir) =>
    call('production.discardAttempt', async () => (await production()).DiscardAttempt(project, packageDir));
  api.production.listBundles = (project) => call('production.listBundles', async () => (await production()).ListBundles(project));
  api.production.removeBundle = (project, path) => call('production.removeBundle', async () => (await production()).RemoveBundle(project, path));
  // Проход агента производства. start ждёт врезки непрерывности и каталог моделей провайдера
  // (до 35 с), поэтому срок ожидания оболочки не ставится; пакет "" — новая подготовка.
  const productionWorkflow = async (view: Promise<productionworkflow.View>): Promise<ProductionWorkflowView> => toProductionWorkflowView(await view);
  api.productionWorkflow.view = (project, shot, packageDir) =>
    call('productionWorkflow.view', async () => productionWorkflow((await b.productionWorkflow()).View(project, shot, packageDir ?? '')));
  api.productionWorkflow.start = (input) =>
    call('productionWorkflow.start', async () => productionWorkflow((await b.productionWorkflow()).Start(input)), false);
  api.productionWorkflow.discard = (project, shot, packageDir, id) =>
    call('productionWorkflow.discard', async () => productionWorkflow((await b.productionWorkflow()).Discard(project, shot, packageDir ?? '', id)));
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
