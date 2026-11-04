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
  GenerationSettings,
  JobInfo,
  JobStepInfo,
  PickOptions,
  ProjectSettings,
  ProjectStatus,
  ScenarioImpactShot,
  SourceManifest,
  TimingFile
} from '@shared/types';
import type { ScenarioStatus } from '@shared/scenario-status';
import type * as status from '../../bindings/songframe-go/internal/status/models';
import type * as jobs from '../../bindings/songframe-go/internal/jobs/models';
import type * as songtiming from '../../bindings/songframe-go/internal/songtiming/models';
import type { VocalModelId, VocalPreparationView } from '@shared/vocals';
import type { NotificationTarget } from '@shared/notifications';
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
  'components.chooseFile'
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

  api.jobs.list = () => call('jobs.list', async () => (await (await b.jobs()).List()).map(toJob));
  api.jobs.get = (id) =>
    call('jobs.get', async () => {
      const info = await (await b.jobs()).Get(id);
      return info === null ? null : toJob(info);
    });
  api.jobs.copyText = (id) => call('jobs.copyText', async () => (await b.jobs()).CopyText(id));

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
