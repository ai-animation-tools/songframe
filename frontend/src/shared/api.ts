import type { VocalModelId, VocalPreparationView } from './vocals';
/** Совместимый контракт UI: реализация Wails принадлежит platform/api, файлы и процессы остаются в Go. */

import type { SongModelSetup } from './song-models';
import type { AgentAccountResult, AgentCheckResult, AgentEvent, AgentJob, AgentModelsResult, AgentSettings, AgentStartInput } from './agents';
import type { ProductionFrameCandidate, ProductionOwnInput, ProductionWorkflowStart, ProductionWorkflowView } from './production-workflow';
import type { MediaCapabilities, MediaKind, ProviderAuth } from './media-providers';
import type { ScenarioWorkflowStart, ScenarioWorkflowView } from './scenario-workflow';
import type { NotificationTarget } from './notifications';
import type { DerivedShotApi } from './derived-shot';
import type { MontageApi } from './montage';
import type { MontageWindowApi } from './montage-window';
import type { ScenarioStatus } from './scenario-status';
import type { ReferenceImageGenerationApi } from './reference-image-generation';
import type { CoverGenerationApi } from './cover-generation';
import type { AiAccess } from './ai-access';
import type { VideoReviewApi } from './video-review';
import type { UpdatesApi } from './updates';
import type { ComponentsApi } from './components';
import type {
  KeyframeNoteScope,
  AcceptOptions,
  PackageView,
  SpeechPlan,
  AcceptedKit,
  PromptLogRecord,
  PromptLogSummary,
  ShotSpend,
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
  ManualVideo,
  PickOptions,
  PreviousSessionInfo,
  RendererErrorReport,
  ProductionView,
  ProductionQuote,
  ProjectStatus,
  ScenarioSaveImpact,
  ScenarioView,
  ScenesFile,
  ScenesSaveMode,
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
  referenceImages: ReferenceImageGenerationApi;
  derivedShots: DerivedShotApi;
  montage: MontageApi;
  montageWindow: MontageWindowApi;
  /** Проверка, скачивание и установка новой версии приложения только по действию пользователя. */
  updates: UpdatesApi;
  videoReview: VideoReviewApi;
  notifications: {
    /** Подписка на переход из уведомления; возвращает отключение; объект события в renderer не попадает. */
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
    /** Речевой план у провайдера без липсинка: собирает без агента пакет для генерации вне приложения (опора, срез речи, промпт). */
    buildManual(project: string, shot: string, packageDir: string): Promise<ProductionWorkflowView>;
    /** Своё описание с планом опор или свой видеопромпт без агента; принимает их интерфейс сразу после применения. */
    saveOwn(input: ProductionOwnInput): Promise<ProductionWorkflowView>;
    /** Изображения, которые может назвать опора своего плана (разрешённые входы плана). */
    referenceImages(project: string, shot: string): Promise<string[]>;
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
    /** Возвращает отключение подписки; объект события Wails в renderer не попадает. */
    onEvent(listener: (event: AgentEvent) => void): () => void;
  };
  app: {
    state(): Promise<AppState>;
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
    /** Название, имя MP4 аниматика, инструкции агенту и блок generation из plan/project.json. */
    settings(project: string): Promise<ProjectSettings>;
    saveSettings(project: string, settings: ProjectSettings): Promise<ProjectSettings>;
  };
  sources: {
    view(project: string): Promise<SourcesView>;
    validate(project: string, input: SourcesInput): Promise<string[]>;
    save(project: string, input: SourcesInput): Promise<SourceManifest>;
  };
  timing: {
    vocalsView(project: string): Promise<VocalPreparationView>;
    downloadVocalModel(model: VocalModelId): Promise<JobInfo>;
    separateVocals(project: string, model: VocalModelId): Promise<JobInfo>;
    selectVocal(project: string, id: string): Promise<VocalPreparationView>;
    deleteVocal(project: string, id: string): Promise<VocalPreparationView>;
    songModelSetup(): Promise<SongModelSetup>;
    downloadSongModels(): Promise<JobInfo>;
    start(project: string, options: TimingGenerateOptions): Promise<JobInfo>;
    cancel(jobId: string): Promise<JobInfo>;
    view(project: string): Promise<TimingView>;
    save(project: string, timing: TimingFile): Promise<TimingFile>;
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
    /** Записывает трактовку черновиком: отклоняется только неверная структура, проблемы показывает validateTreatment. */
    saveTreatment(project: string, treatment: TreatmentFile): Promise<TreatmentFile>;
    /** Проблемы трактовки без записи: стык частей, длительность трека, коды и названия. Черновик с проблемами сохраняется, поэтому они нужны до записи. */
    validateTreatment(project: string, treatment: TreatmentFile): Promise<string[]>;
    /** mode=keep оставляет принятые комплекты и пакеты затронутых планов в силе: правка не относится к сюжету. */
    saveScenes(project: string, scenes: ScenesFile, mode: ScenesSaveMode): Promise<ScenesFile>;
    /** Какие планы затронет сохранение черновика: сравнение отпечатков постановки без записи. */
    saveImpact(project: string, scenes: ScenesFile): Promise<ScenarioSaveImpact>;
    /** Проверка реестра без записи: список проблем. */
    validateScenes(project: string, scenes: ScenesFile): Promise<string[]>;
    brief(project: string, scenes: ScenesFile, shot: string, phase: 'before' | 'after'): Promise<BriefResult>;
  };
  production: {
    view(project: string): Promise<ProductionView>;
    /** Ответ пользователя на вопрос пакета: пишется через shot_workflow decide. */
    decide(project: string, packageDir: string, verdict: string, note?: string, decisionToken?: string, noteScope?: KeyframeNoteScope): Promise<void>;
    /** Вернуть утверждённую опору на доработку с замечанием, пока видеопромпт не утверждён. */
    reopenFrame(project: string, packageDir: string, frame: string, note: string, noteScope: KeyframeNoteScope): Promise<void>;
    /** Вернуть утверждённый видеопромпт на доработку с замечанием, пока запрос видео не отправлен; описание и опоры остаются. */
    reopenPrompt(project: string, packageDir: string, note: string): Promise<void>;
    /** Оставить неотправленный пакет в силе для текущей постановки плана: правка сценария не меняет его материалы. */
    keepPackageForScene(project: string, packageDir: string): Promise<void>;
    /** Необязательное указание к опоре до её создания: записывается как замечание к опорам. */
    addKeyframeNote(project: string, packageDir: string, frame: string, note: string, noteScope: KeyframeNoteScope): Promise<void>;
    /** Включить или снять замечание к опорам пакета. */
    setKeyframeNote(project: string, packageDir: string, id: number, active: boolean): Promise<void>;
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
    /** Продолжает получение по сохранённому ID задания; без ID доступны только два действия ниже. */
    resume(project: string, packageDir: string): Promise<JobInfo>;
    /** Неизвестный исход: файл, скачанный пользователем из истории генераций сервиса, становится оригиналом попытки. */
    attachResult(project: string, packageDir: string, files: string[]): Promise<JobInfo>;
    /** Неизвестный исход: генерации нет в истории сервиса, попытка снова ждёт подтверждения отправки. */
    markNotCreated(project: string, packageDir: string): Promise<void>;
    /** Видео, созданное вне приложения по пакету ручной генерации, становится оригиналом попытки с источником и примечаниями. */
    attachManual(project: string, packageDir: string, result: ManualVideo): Promise<JobInfo>;
    /** Выбирает кандидат опоры; художественное утверждение кадра выполняется отдельно. */
    selectImage(project: string, packageDir: string, index: number, expectedResultToken: string): Promise<void>;
    regenerate(project: string, shot: string): Promise<JobInfo>;
    accept(project: string, shot: string, packageDir: string, options: AcceptOptions): Promise<JobInfo>;
    contactSheet(project: string, packageDir: string): Promise<JobInfo>;
    park(project: string, packageDir: string): Promise<void>;
    /** Строки песни в окне речевого плана и предложенные границы среза. */
    speechPlan(project: string, shot: string, packageDir?: string): Promise<SpeechPlan>;
    /** Источник генерации, опоры, промпт и срез речи принятого плана по его комплекту; null — комплекта из генерации нет. */
    acceptedKit(project: string, shot: string): Promise<AcceptedKit | null>;
    /** Расход плана: попытки, отправки, суммы в исходных единицах, неизвестный расход и стоимость секунды принятого материала. */
    spend(project: string, shot: string): Promise<ShotSpend>;
    /** Режет точный WAV липсинка в audio/ пакета; без границ — по разметке «Таймингов». */
    prepareSpeech(project: string, packageDir: string, bounds?: { start: number; end: number }): Promise<PackageView>;
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
  promptLog: {
    /** Отправки проекта агенту и сервисам генерации, от новых к старым (plan/prompt-log). */
    list(project: string): Promise<PromptLogSummary[]>;
    /** Полная запись отправки: промпт, контекст, вложения, ответ; null — записи нет. */
    get(project: string, id: string): Promise<PromptLogRecord | null>;
  };
  animatic: {
    view(project: string): Promise<AnimaticView>;
    /** Задание: update_scene_views, затем build_animatic (с --plan-only только проверка входов). */
    build(project: string, planOnly: boolean): Promise<JobInfo>;
    /**
     * Задание просмотра планов from…to под участок песни: update_scene_views, затем build_animatic --from --to.
     * Видео — plan/animatic/.cache/fragment/fragment.mp4 проекта (каждая сборка заменяет его); latest и принятие аниматика не меняются.
     */
    fragment(project: string, from: string, to: string): Promise<JobInfo>;
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
    /** Задания этого и прошлых сеансов; у прошлых log пуст, хвост журнала даёт get. */
    list(): Promise<JobInfo[]>;
    get(id: string): Promise<JobInfo | null>;
    /** Сведения задания и его журнал с диска одним текстом для копирования. */
    copyText(id: string): Promise<string>;
  };
  diagnostics: {
    /** Необработанная ошибка окна в журнал сбоев localDir/logs/app.log. */
    reportRendererError(report: RendererErrorReport): void;
    /** Сведения об аварийном прошлом сеансе; один раз за запуск, иначе null. */
    crashNotice(): Promise<PreviousSessionInfo | null>;
    /** Отчёт для разработчика через диалог сохранения; путь файла или null при отмене. */
    saveReport(): Promise<string | null>;
  };
  environment: {
    check(onProgress?: (check: EnvironmentCheck) => void): Promise<EnvironmentCheck[]>;
    /** Вход в платного провайдера: приложение открывает страницу авторизации в браузере и ждёт подтверждения. */
    loginProvider(provider: string): Promise<{ ok: boolean; message: string }>;
    /** Прервать ожидание входа. */
    cancelLogin(provider: string): Promise<void>;
    /** Адрес авторизации текущего входа: страница показывает его ссылкой, если браузер не открылся. */
    onLoginUrl(listener: (value: { provider: string; url: string }) => void): () => void;
    providerAuth(provider: string): Promise<ProviderAuth>;
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
    /** Веб-адрес http или https в браузере ОС: встроенное окно внешние ссылки само не открывает. */
    openExternal(url: string): Promise<void>;
    /** Текст небольшого файла (текст песни, идея) для подстановки в форму. */
    readText(path: string): Promise<string>;
    /** Текст буфера обмена ОС для «Вставить» контекстного меню: WebKit не даёт странице читать его сам. */
    clipboardText(): Promise<string>;
    /** Абсолютный путь в URL локального медиасервера Go для <img>, <audio> и <video>; синхронно. */
    fileUrl(path: string): string;
    /**
     * Файлы, перетащенные с диска на элемент с data-file-drop-target и этим id. Пути приходят
     * событием нативного drop Wails уже после DOM drop; синтетический File пути не даёт.
     */
    onFilesDropped(listener: (drop: FilesDrop) => void): () => void;
  };
  components: ComponentsApi;
}

/** Нативный drop: id целевого элемента и абсолютные пути файлов в порядке ОС. */
export interface FilesDrop {
  targetId: string;
  paths: string[];
}
