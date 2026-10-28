/** Контракт между рендерером и главным процессом: имена каналов и сигнатуры window.api. */

import type { WhisperSetup, WhisperModelId } from './whisper-models';
import type { AgentAccountResult, AgentCheckResult, AgentEvent, AgentJob, AgentModelsResult, AgentSettings, AgentStartInput } from './agents';
import type { ProductionFrameCandidate, ProductionWorkflowStart, ProductionWorkflowView } from './production-workflow';
import type { MediaCapabilities, MediaKind } from './media-providers';
import type { ScenarioWorkflowStart, ScenarioWorkflowView } from './scenario-workflow';
import type { NotificationTarget } from './notifications';
import type { MontageApi } from './montage';
import type { MontageWindowApi } from './montage-window';
import type { ScenarioStatus } from './scenario-status';
import type { CoverGenerationApi } from './cover-generation';
import type { AiAccess } from './ai-access';
import type {
  AcceptOptions,
  AnimaticView,
  AppState,
  BriefResult,
  BundleInfo,
  CheckId,
  CheckInfo,
  CheckOptions,
  ExportBundleOptions,
  ProjectSettings,
  ReviewInfo,
  ReviewOptions,
  CastFile,
  CastView,
  CreateProjectInput,
  DashboardView,
  EnvironmentCheck,
  JobInfo,
  PickOptions,
  ProductionView,
  ProductionQuote,
  ProjectStatus,
  ScenarioView,
  ScenesFile,
  SourceManifest,
  SourcesInput,
  SourcesView,
  TimingFile,
  TimingGenerateOptions,
  TimingView,
  ToolResult,
  TreatmentFile
} from './types';

export interface Api {
  ai: {
    /** Явный выбор и проверенная доступность исполнителей; значения по умолчанию не дают разрешение запуска. */
    access(project: string | null): Promise<AiAccess>;
  };
  cover: CoverGenerationApi;
  montage: MontageApi;
  montageWindow: MontageWindowApi;
  notifications: {
    /** Подписка на переход из уведомления; возвращает отключение без объекта события Electron. */
    onOpen(listener: (target: NotificationTarget) => void): () => void;
  };
  media: {
    /** Читает объявления CLI, не загружает референсы и не отправляет генерацию. */
    capabilities(project: string, kind: MediaKind, provider: string): Promise<MediaCapabilities>;
  };
  productionWorkflow: {
    view(project: string, shot: string, packageDir?: string): Promise<ProductionWorkflowView>;
    start(input: ProductionWorkflowStart): Promise<ProductionWorkflowView>;
    apply(project: string, shot: string, packageDir: string | undefined, id: string): Promise<ProductionWorkflowView>;
    discard(project: string, shot: string, packageDir: string | undefined, id: string): Promise<ProductionWorkflowView>;
    generateFrames(project: string, shot: string, packageDir: string): Promise<ProductionWorkflowView>;
    importFrames(project: string, shot: string, packageDir: string, images: ProductionFrameCandidate[]): Promise<ProductionWorkflowView>;
  };
  scenarioWorkflow: {
    view(project: string): Promise<ScenarioWorkflowView>;
    start(input: ScenarioWorkflowStart): Promise<ScenarioWorkflowView>;
    apply(project: string, id: string): Promise<ScenarioWorkflowView>;
    approveCurrent(project: string): Promise<ScenarioWorkflowView>;
    approveScenes(project: string): Promise<ScenarioWorkflowView>;
    discard(project: string, id: string): Promise<ScenarioWorkflowView>;
  };
  agents: {
    getSettings(): Promise<AgentSettings | null>;
    getProviderSettings(provider: AgentSettings['provider']): Promise<AgentSettings | null>;
    saveProviderSettings(settings: AgentSettings): Promise<AgentSettings>;
    saveSettings(settings: AgentSettings | null): Promise<AgentSettings | null>;
    /** Проверяет форму без сохранения, генерации и проверки доступа к модели. */
    check(settings: AgentSettings): Promise<AgentCheckResult>;
    /** Получает доступные CLI сведения об аккаунте и лимитах без генерации и сохранения формы. */
    account(settings: AgentSettings): Promise<AgentAccountResult>;
    /** Каталог моделей найденного CLI служебным вызовом; пустой список не запрещает ввод модели вручную. */
    models(settings: AgentSettings): Promise<AgentModelsResult>;
    start(input: AgentStartInput): Promise<AgentJob>;
    cancel(id: string): Promise<AgentJob>;
    get(id: string): Promise<AgentJob | null>;
    list(project?: string): Promise<AgentJob[]>;
    /** Возвращает отключение подписки; объект события Electron в renderer не попадает. */
    onEvent(listener: (event: AgentEvent) => void): () => void;
  };
  app: {
    state(): Promise<AppState>;
    setToolsRoot(path: string | null): Promise<AppState>;
  };
  projects: {
    open(path: string): Promise<ProjectStatus>;
    create(input: CreateProjectInput): Promise<ProjectStatus>;
    validateNew(input: CreateProjectInput): Promise<string[]>;
    status(path: string): Promise<ProjectStatus>;
    /** Меняет название без переименования папки и без изменения настроек генерации. */
    rename(path: string, name: string): Promise<ProjectStatus>;
    close(): Promise<void>;
    forget(path: string): Promise<void>;
    /** Название, имя MP4 аниматика и блок generation из plan/project.json. */
    settings(project: string): Promise<ProjectSettings>;
    saveSettings(project: string, settings: ProjectSettings): Promise<ProjectSettings>;
  };
  sources: {
    view(project: string): Promise<SourcesView>;
    validate(project: string, input: SourcesInput): Promise<string[]>;
    save(project: string, input: SourcesInput): Promise<SourceManifest>;
  };
  timing: {
    /** Ресурсы компьютера, рекомендуемая модель и локальные каталоги установки. */
    modelSetup(): Promise<WhisperSetup>;
    /** Запускает встроенный загрузчик; состояние и журнал доступны через jobs. */
    downloadModel(model: WhisperModelId): Promise<JobInfo>;
    view(project: string): Promise<TimingView>;
    save(project: string, timing: TimingFile): Promise<TimingFile>;
    /** Запускает align_lyrics; распознавание длится минуты, ответ приходит по завершении. */
    generate(project: string, options: TimingGenerateOptions): Promise<ToolResult>;
  };
  cast: {
    view(project: string): Promise<CastView>;
    /** Создаёт кастинг из референсов исходников или дополняет существующий. */
    init(project: string): Promise<CastFile>;
    save(project: string, cast: CastFile): Promise<CastFile>;
  };
  scenario: {
    /** Готовность сценария для страниц, которые работают со сценами. */
    status(project: string): Promise<ScenarioStatus>;
    view(project: string): Promise<ScenarioView>;
    saveTreatment(project: string, treatment: TreatmentFile): Promise<TreatmentFile>;
    saveScenes(project: string, scenes: ScenesFile): Promise<ScenesFile>;
    /** Проверка реестра без записи: список проблем. */
    validateScenes(project: string, scenes: ScenesFile): Promise<string[]>;
    brief(project: string, scenes: ScenesFile, shot: string, phase: 'before' | 'after'): Promise<BriefResult>;
  };
  production: {
    view(project: string): Promise<ProductionView>;
    /** Ответ пользователя на вопрос пакета: пишется через shot_workflow decide. */
    decide(project: string, packageDir: string, verdict: string, note?: string, decisionToken?: string): Promise<void>;
    /** Платная отправка подготовленной попытки пакета; разрешение даёт нажатие кнопки. */
    quote(project: string, packageDir: string, expectedSha: string, decisionToken?: string): Promise<ProductionQuote>;
    submit(
      project: string,
      packageDir: string,
      expectedSha: string,
      decisionToken?: string,
      quoteToken?: string,
      unknownCostConsentToken?: string
    ): Promise<JobInfo>;
    resume(project: string, packageDir: string, generationId?: string): Promise<JobInfo>;
    /** Выбирает кандидат опоры; художественное утверждение кадра выполняется отдельно. */
    selectImage(project: string, packageDir: string, index: number, expectedResultToken: string): Promise<void>;
    regenerate(project: string, shot: string): Promise<JobInfo>;
    accept(project: string, shot: string, packageDir: string, options: AcceptOptions): Promise<JobInfo>;
    contactSheet(project: string, packageDir: string): Promise<JobInfo>;
    park(project: string, packageDir: string): Promise<void>;
    /** Снова задать вопрос о полученном результате пакета приложения, если ответ уже записан. */
    reopenQuestion(project: string, packageDir: string): Promise<void>;
    /** Удалить пакет попытки целиком, включая оплаченный оригинал; незавершённая отправка не удаляется. */
    discardAttempt(project: string, packageDir: string): Promise<void>;
    /** Пакет для монтажёра: таблица планов, EDL, FCPXML, строки песни; с копированием медиа по желанию. */
    exportBundle(project: string, options: ExportBundleOptions): Promise<JobInfo>;
    listBundles(project: string): Promise<BundleInfo[]>;
    /** Удаляет собранную папку BundleInfo.dir вместе с экспортом и копиями медиа. */
    removeBundle(project: string, path: string): Promise<void>;
  };
  dashboard: {
    view(project: string): Promise<DashboardView>;
  };
  animatic: {
    view(project: string): Promise<AnimaticView>;
    /** Задание: update_scene_views, затем build_animatic (с --plan-only только проверка входов). */
    build(project: string, planOnly: boolean): Promise<JobInfo>;
    /** Принятие текущей сборки или возврат на просмотр в plan/production-status.json. */
    setStatus(project: string, status: 'approved' | 'review'): Promise<AnimaticView>;
  };
  checks: {
    list(): Promise<CheckInfo[]>;
    /** Одна проверка заданием: журнал и код завершения в jobs. */
    run(project: string, id: CheckId, options?: CheckOptions): Promise<JobInfo>;
    /** Все проверки одним заданием, без остановки на первой ошибке. */
    runAll(project: string, options?: CheckOptions): Promise<JobInfo>;
    /** update_scene_views без --check: перерисовывает представления и карточки. */
    updateViews(project: string): Promise<JobInfo>;
    /** Проба стыков build_review в plan/batches/review-<метка>/review.mp4. */
    buildReview(project: string, options: ReviewOptions): Promise<JobInfo>;
    listReviews(project: string): Promise<ReviewInfo[]>;
    /** Удаляет ReviewInfo.video и одноимённый JSON рецепта, сохраняя соседние рабочие файлы. */
    removeReview(project: string, path: string): Promise<void>;
  };
  jobs: {
    list(): Promise<JobInfo[]>;
    get(id: string): Promise<JobInfo | null>;
  };
  environment: {
    check(onProgress?: (check: EnvironmentCheck) => void): Promise<EnvironmentCheck[]>;
    loginKling(): Promise<{ ok: boolean; message: string }>;
    klingAuth(): Promise<{ status: 'authenticated' | 'unauthenticated' | 'unknown'; message?: string }>;
  };
  tools: {
    run(project: string, name: string, args: string[]): Promise<ToolResult>;
  };
  dialog: {
    pickFolder(options?: PickOptions): Promise<string | null>;
    pickFiles(options?: PickOptions): Promise<string[]>;
  };
  shell: {
    openPath(path: string): Promise<void>;
    /** Текст небольшого файла (текст песни, идея) для подстановки в форму. */
    readText(path: string): Promise<string>;
    /** Абсолютный путь в URL локального протокола для <img> и <audio>. */
    fileUrl(path: string): string;
    /** Путь файла, перетащенного пользователем с диска; синтетический File возвращает пустую строку. */
    pathForFile(file: File): string;
  };
}

/**
 * Схема локального протокола: local-file://local/abs/path отдаёт файл с диска. Хост `local` фиктивный:
 * у стандартной схемы первый сегмент пути иначе становится хостом, и путь ломается.
 */
export const LOCAL_FILE_SCHEME = 'local-file';
export const LOCAL_FILE_HOST = 'local';

export function toLocalFileUrl(path: string): string {
  const normalized = path.split('\\').join('/');
  return `${LOCAL_FILE_SCHEME}://${LOCAL_FILE_HOST}${normalized.startsWith('/') ? '' : '/'}${encodeURI(normalized)}`;
}
