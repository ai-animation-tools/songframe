/** Общие типы главного процесса и рендерера: состояние приложения, проект, исходники, среда. */
import type { MediaModelSelection } from './media-providers';
import type { WhisperModelId } from './whisper-models';
import type { FPS } from './video';

/** Вычисляемое состояние проекта; хранится нигде, выводится из файлов папки. */
export type ProjectState = 'invalid' | 'empty' | 'sourced' | 'timed' | 'scripted' | 'in_production' | 'complete';

export interface ProjectStatus {
  path: string;
  state: ProjectState;
  /** Название из plan/project.json либо имя папки для не-проекта. */
  name: string;
  animaticVideo: string | null;
  /** Признаки, из которых выведено состояние; показываются на странице проекта. */
  checks: {
    marker: boolean;
    sources: boolean;
    timing: boolean;
    cast: boolean;
    treatment: boolean;
    scenes: boolean;
    shotsTotal: number;
    shotsDone: number;
    animaticBuilt: boolean;
    animaticFresh: boolean;
    animaticApproved: boolean;
  };
  /** Что мешает перейти дальше или что сломано; пусто у здорового проекта. */
  problems: string[];
}

export interface ProjectHistoryEntry {
  path: string;
  name: string;
  lastOpened: string;
  exists: boolean;
}

export interface AppState {
  packaged: boolean;
  problems: string[];
  /** Корень комплекса (где лежат tools и templates) или null, если найти не удалось. */
  toolsRoot: string | null;
  /** Постоянная папка состояния: userData либо явно выбранная SONGFRAME_LOCAL_DIR. */
  localDir: string;
  current: string | null;
  history: ProjectHistoryEntry[];
  platform: NodeJS.Platform;
}

export interface CreateProjectInput {
  name: string;
  path: string;
  animaticVideo?: string;
}

/** Код типа референса; набор типов открыт и хранится в source/manifest.json (kinds). */
export type ReferenceKind = string;

/** Тип референсов проекта: код, подпись и папка внутри source. */
export interface SourceKind {
  id: string;
  label: string;
  dir: string;
}

export const DEFAULT_SOURCE_KINDS: SourceKind[] = [
  { id: 'character', label: 'Персонаж', dir: 'heroes' },
  { id: 'vehicle', label: 'Транспорт', dir: 'vehicles' },
  { id: 'location', label: 'Локация', dir: 'locations' },
  { id: 'prop', label: 'Предмет', dir: 'props' },
  { id: 'style', label: 'Стиль', dir: 'style' }
];
export type ReferenceView = 'full' | 'face' | 'front' | 'side' | 'back' | 'top' | 'other';

export interface ManifestFile {
  path: string;
  sha256: string;
  bytes: number;
}

export interface ReferenceFile extends ManifestFile {
  view: ReferenceView;
  note: string;
  /** Промпт именно этого изображения: путь относительно source; отсутствие не наследует общий промпт. */
  prompt?: string | null;
}

export interface SourceReference {
  id: string;
  kind: ReferenceKind;
  name: string;
  short_name: string;
  description: string;
  files: ReferenceFile[];
  /** Общий промпт старого формата; не относится автоматически к отдельным изображениям. */
  prompt: string | null;
}

/** source/manifest.json: что из исходников чем является. */
export interface SourceManifest {
  schema_version: 1;
  /** Типы референсов; у манифестов без поля действует набор по умолчанию. */
  kinds?: SourceKind[];
  track: (ManifestFile & { original_name: string; duration_seconds: number | null }) | null;
  lyrics: (ManifestFile & { lines: number; sections: string[] }) | null;
  idea: ManifestFile | null;
  /** Только оформление проекта; не является референсом кастинга, сцен или генерации. */
  cover: ManifestFile | null;
  references: SourceReference[];
  updated_at: string;
}

/** Ввод формы исходников: новое берётся из абсолютных путей или текста, старое остаётся по умолчанию. */
export interface SourcesInput {
  /** Полный список типов из формы; отсутствие означает набор по умолчанию или прежний из манифеста. */
  kinds?: SourceKind[];
  track: { path: string } | null;
  lyrics: { path: string } | { text: string } | null;
  idea: { path: string } | { text: string } | null;
  cover: { path: string } | { remove: true } | null;
  references: ReferenceInput[];
}

export interface ReferenceInput {
  id: string;
  kind: ReferenceKind;
  name: string;
  short_name: string;
  description: string;
  /** Общий промпт старого формата, отдельно от промптов изображений. */
  prompt: string;
  files: ReferenceFileInput[];
}

export interface ReferenceFileInput {
  /** Новый файл для копирования (абсолютный путь) либо уже сохранённый (путь внутри source). */
  sourcePath?: string;
  existingPath?: string;
  view: ReferenceView;
  note: string;
  /** Текст промпта: undefined сохраняет прежнюю привязку existingPath, пустая строка удаляет её. */
  prompt?: string;
}

export interface SourcesView {
  manifest: SourceManifest | null;
  lyricsText: string;
  ideaText: string;
  /** Абсолютные пути к файлам для предпросмотра через file://. */
  coverPath: string | null;
  referenceFilePaths: Record<string, string>;
  problems: string[];
}

export interface EnvironmentCheck {
  id: string;
  label: string;
  ok: boolean;
  /** Что найдено: версия, путь. */
  detail: string;
  /** Что сделать, если не ok. */
  hint: string;
  /** Нужна только для производства, просмотр без неё работает. */
  productionOnly: boolean;
  /** Время фактической проверки, чтобы медленная зависимость была видна в диагностике. */
  elapsedMs?: number;
  /** Незавершённая проверка ещё не означает отсутствие зависимости. */
  status?: 'pending' | 'running' | 'done';
  /** Компонент входит в поставку и не требует отдельной установки. */
  bundled?: boolean;
}

export interface ToolResult {
  code: number | null;
  stdout: string;
  stderr: string;
  command: string;
}

export interface PickOptions {
  title?: string;
  filters?: { name: string; extensions: string[] }[];
  multiple?: boolean;
}

export const REFERENCE_VIEW_LABELS: Record<ReferenceView, string> = {
  full: 'В полный рост',
  face: 'Лицо',
  front: 'Спереди',
  side: 'Сбоку',
  back: 'Сзади',
  top: 'Сверху',
  other: 'Другое'
};

export const PROJECT_STATE_LABELS: Record<ProjectState, string> = {
  invalid: 'Не проект',
  empty: 'Создан',
  sourced: 'Исходники загружены',
  timed: 'Трек размечен',
  scripted: 'Готов к производству',
  in_production: 'В производстве',
  complete: 'Завершён'
};

/** Строка разметки песни: физический номер строки text.md и оценка границ в секундах трека. */
export interface TimingLine {
  id: number;
  source_line: number;
  start: number;
  end: number;
  verified?: boolean;
  note?: string;
}

export interface TimingSection {
  name: string;
  start: number;
  end: number;
  note?: string;
}

/** plan/audio/timing.json версии 2 (версия формата с verified у строк). */
export interface TimingFile {
  version: 2;
  status: string;
  source: string;
  sha256: string | null;
  duration_decoded: number | null;
  duration_container: number | null;
  clock: string;
  lines: TimingLine[];
  sections: TimingSection[];
}

export interface LyricsLine {
  /** Физический номер строки в source/text.md, с единицы. */
  number: number;
  text: string;
  /** Заголовок части вида [Припев]: таких строк в разметке нет. */
  header: boolean;
}

export interface TimingView {
  timing: TimingFile | null;
  lyrics: LyricsLine[];
  /** Абсолютный путь трека для плеера и волны или null, если трека нет. */
  trackPath: string | null;
  /** Версия содержимого: путь track.mp3 остаётся прежним при замене трека. */
  trackSha256: string | null;
  duration: number | null;
  problems: string[];
}

export interface TimingGenerateOptions {
  device?: 'auto' | 'cpu';
  model?: string;
  recognition?: string;
  reset?: boolean;
}

/** Свойство состояния из словаря кастинга: подпись, подсказка, типовые значения, шаблон вопроса чек-листа. */
export interface CastProperty {
  key: string;
  label: string;
  hint?: string;
  values?: string[];
  checklist?: string;
}

export interface CastEntity {
  id: string;
  kind: string;
  name: string;
  short_name: string;
  role: string;
  appearance: string;
  /** Пути изображений внутри source; первый основной для карточек. */
  images: string[];
  initial_state: Record<string, string>;
}

/** plan/cast.json: сущности клипа и словарь свойств состояния по типам. */
export interface CastFile {
  schema_version: 1;
  entities: CastEntity[];
  properties: Record<string, CastProperty[]>;
}

export interface CastView {
  cast: CastFile | null;
  manifest: SourceManifest | null;
  /** Абсолютные пути изображений по относительному пути внутри source. */
  imagePaths: Record<string, string>;
  problems: string[];
}

export interface TreatmentSequence {
  id: string;
  title: string;
  direction: string;
  start: number;
  end: number;
  entities: string[];
  lipsync?: boolean;
  max_shot_seconds?: number;
}

/** plan/treatment.json: логлайн и части песни первого прохода сценария. */
export interface TreatmentFile {
  schema_version: 1;
  logline: string;
  sequences: TreatmentSequence[];
}

export type StateFrom = null | string | { scene: string; phase: 'before' | 'after' | 'same' };
/** Изменения состояния: сущность → свойство → значение; null удаляет свойство. */
export type StateDelta = Record<string, Record<string, string | null>>;

export interface SceneShot {
  id: string;
  original: string;
  sequence: string;
  title?: string;
  start_frame: number;
  end_frame_exclusive: number;
  camera: string;
  action: string;
  continuity: string;
  notes?: string;
  references: string[];
  lipsync: boolean;
  card: { primary_reference: string };
  state_from: StateFrom;
  state_changes: { before?: StateDelta; after?: StateDelta };
}

export interface SceneReference {
  name: string;
  path: string;
  short_name?: string;
}

/** plan/scenes.json: реестр постановки и монтажной шкалы (кадровая сетка и постановка). */
export interface ScenesFile {
  schema_version: 1;
  fps: typeof FPS;
  audio: { path: string; end_seconds: string };
  references: Record<string, SceneReference>;
  visual_direction: string;
  sequences: { id: string; title: string; direction: string }[];
  scenes: SceneShot[];
}

export type EntityState = Record<string, Record<string, string>>;
export interface ResolvedState {
  before: EntityState;
  after: EntityState;
}

export interface ScenarioView {
  scenes: ScenesFile | null;
  treatment: TreatmentFile | null;
  cast: CastFile | null;
  timing: TimingFile | null;
  lyrics: LyricsLine[];
  duration: number | null;
  trackPath: string | null;
  problems: string[];
}

export interface BriefResult {
  shot: string;
  phase: 'before' | 'after';
  state: EntityState;
  paragraph: string;
  checklist: string[];
  text: string;
}

/** Производство: completed означает приёмку; доступность монтажного файла отражена в asset.video. */
export type ShotProductionState = 'planned' | 'progress' | 'completed' | 'unknown';

export interface PackageKeyframe {
  id: string;
  role: 'first' | 'middle' | 'last';
  time_seconds: number;
  note?: string | null;
  /** Абсолютный путь к изображению кандидата или принятой опоры. */
  imagePath: string | null;
  approved: boolean;
}

export interface PackageView {
  executor?: 'app' | 'agent';
  /** Хеш показанных оригиналов не меняется от записи ответа пользователя. */
  resultToken?: string;
  /** Встроенное приложение владеет следующими действиями; внешний агент не исполняет их повторно. */
  managed?: boolean;
  /** Связь ответа с показанным вопросом и его материалами. */
  decisionToken?: string;
  /** Папка пакета (абсолютный путь). */
  dir: string;
  relative: string;
  shot: string;
  stage: string;
  stageLabel: string;
  waitReason: string | null;
  mode: string | null;
  retryOf: string | null;
  batch: string | null;
  timing: { frames?: number; window_seconds?: number; request_seconds?: number | null } | null;
  keyframes: PackageKeyframe[];
  /** Описание этапа 1 из description.md пакета, если агент его записал. */
  description: string | null;
  prompt: { path: string; approved: boolean; text: string } | null;
  request: {
    dir: string;
    kind?: 'image' | 'video';
    provider?: string;
    command?: string;
    frameId?: string;
    sha256: string | null;
    model: string;
    modelSelection?: MediaModelSelection;
    parameters: Record<string, unknown>;
    inputs: { slot?: string; role?: string; path: string; imagePath: string }[];
    attemptStatus: string | null;
    /** Замороженный текст из папки попытки; может отличаться от черновика пакета. */
    promptText?: string | null;
    generationId: string | null;
    creditsConsumed: number | null;
    /** Абсолютные пути скачанных оригиналов. */
    downloads: string[];
  } | null;
  pendingDecision: { stage: string; question: string; options: string[]; asked_at?: string; executor?: string } | null;
  decision: { stage: string; verdict: string | null; note?: string; at?: string } | null;
  /** Файлы технической сводки (контактный лист, превью), если она уже сделана. */
  preview: string[];
  problems: string[];
}

export interface ShotProduction {
  id: string;
  title: string;
  original: string;
  start: number;
  end: number;
  lipsync: boolean;
  state: ShotProductionState;
  stageLabel: string;
  /** Принятые материалы в assets: пути только к существующим файлам видео и оригинала. */
  asset: { dir: string; video: string | null; original: string | null } | null;
  packages: PackageView[];
}

export interface ProductionView {
  shots: ShotProduction[];
  problems: string[];
  /** Есть ли Python и kling: без них действия недоступны, просмотр работает. */
  tools: { python: boolean; kling: boolean };
}

/** Актуальная стоимость показанного запроса; token одноразовый и не переживает перезапуск. */
export interface ProductionQuote {
  token: string;
  requestSha: string;
  verdict: 'ok' | 'insufficient_balance' | 'cost_or_balance_unknown';
  credits: number | null;
  balance: number | null;
  reasons: string[];
}

export type JobKind = 'submit' | 'regenerate' | 'accept' | 'contact_sheet' | 'tool' | 'check' | 'review' | 'animatic' | 'model_download';

/** Шаг задания: один вызов инструмента с его кодом завершения. */
export interface JobStepInfo {
  label: string;
  tool: string;
  status: 'pending' | 'running' | 'done' | 'failed';
  code: number | null;
}

export interface JobInfo {
  id: string;
  /** Проект задания; отсутствие значения означает общее задание приложения. */
  project?: string | null;
  kind: JobKind;
  title: string;
  status: 'running' | 'done' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  /** Хвост журнала; полный лог в localDir/jobs/<id>.log. */
  log: string;
  code: number | null;
  steps: JobStepInfo[];
  /** Загрузка весов относится к приложению, а не к данным текущего клипа. */
  modelDownload?: { model: WhisperModelId; directory: string };
}

/** Проверка проекта из панели: какой инструмент и с какими ключами запускается. */
export type CheckId = 'lint' | 'views' | 'assets' | 'workspace' | 'status';

export interface CheckInfo {
  id: CheckId;
  label: string;
  description: string;
  tool: string;
  /** Проверка осмысленна только при наличии реестра сцен. */
  needsScenes: boolean;
}

export interface CheckOptions {
  /** lint_registry: предупреждения тоже считать ошибками. */
  strict?: boolean;
  /** shot_status: только кандидат next и очередь. */
  next?: boolean;
}

export interface ReviewOptions {
  /** Коды планов подряд по шкале: готовые идут клипами, остальные карточками. */
  shots: string[];
  /** Только рецепт без кодирования: проверка параметров и медиа. */
  planOnly: boolean;
}

/** Собранная проба стыков в plan/batches: MP4 и одноимённый JSON с рецептом. */
export interface ReviewInfo {
  dir: string;
  video: string;
  manifest: string;
  shots: string[];
  totalFrames: number;
  createdAt: string;
}

export type DurationRule = 'min_supported_strictly_greater_than_window' | 'min_supported_not_less_than_window' | 'exact_window';

export const DURATION_RULES: DurationRule[] = ['min_supported_strictly_greater_than_window', 'min_supported_not_less_than_window', 'exact_window'];

export const DURATION_RULE_LABELS: Record<DurationRule, string> = {
  min_supported_strictly_greater_than_window: 'Ближайшая поддерживаемая длительность строго больше окна',
  min_supported_not_less_than_window: 'Ближайшая поддерживаемая длительность не меньше окна',
  exact_window: 'Ровно окно сцены'
};

/** Настройки видео; неизвестные параметры сохраняются для подключаемых провайдеров. */
export interface VideoGenerationSettings {
  provider: string;
  /** Только явный выбор пользователя; старое имя провайдера само по себе выбором не считается. */
  provider_selected?: boolean;
  resolution: string;
  aspect_ratio: string;
  watermark: boolean;
  duration_rule: DurationRule;
  model?: string;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

export interface ImageGenerationSettings {
  provider: string;
  /** Только явный выбор пользователя; отсутствие маркера оставляет генерацию ненастроенной. */
  provider_selected?: boolean;
  aspect_ratio?: string;
  resolution?: string;
  /** Kling: предпочтительная модель генерации. Codex: модель агента, вызывающего встроенный image_gen. */
  model?: string;
  outputs?: number;
  watermark?: boolean;
  options?: Record<string, unknown>;
  [key: string]: unknown;
}

/** Независимые настройки медиа: отсутствующий блок не наследуется из другого. */
export interface GenerationSettings {
  video: VideoGenerationSettings | null;
  image: ImageGenerationSettings | null;
  [key: string]: unknown;
}

export const DEFAULT_VIDEO_GENERATION: VideoGenerationSettings = {
  provider: 'kling',
  resolution: '1080p',
  aspect_ratio: '16:9',
  watermark: false,
  duration_rule: 'min_supported_strictly_greater_than_window'
};

// Codex исполняет свой контракт опор; параметры запроса Kling не выдаём за настройки встроенного image_gen.
export const DEFAULT_IMAGE_GENERATION: ImageGenerationSettings = { provider: 'codex' };
export const DEFAULT_KLING_IMAGE_GENERATION: ImageGenerationSettings = { provider: 'kling', resolution: '2k', aspect_ratio: '16:9', outputs: 1 };

export const DEFAULT_GENERATION: GenerationSettings = {
  video: null,
  image: null
};

/** Редактируемая часть plan/project.json; прочие поля файла сохраняются как есть. */
export interface ProjectSettings {
  name: string;
  animaticVideo: string;
  /** null, если блока в файле нет: панель предлагает заполнить. */
  generation: GenerationSettings | null;
}

export interface AcceptOptions {
  expectedResultToken?: string;
  /** full: оригинал целиком совпадает с окном; cut: участок оригинала в секундах. */
  mode: 'full' | 'cut';
  cutStart?: number;
  cutEnd?: number;
  speed?: string;
  holdFirst?: number;
  holdLast?: number;
}

export interface ExportBundleOptions {
  /** Папка пакета: пустая, вне репозитория или внутри plan/batches. */
  target: string;
  /** Скопировать медиа в media/ пакета, иначе пути относительны проекту. */
  copy: boolean;
}

export interface BundleInfo {
  dir: string;
  createdAt: string | null;
  shots: number;
  videos: number;
  copied: boolean;
}

/** План в собранном аниматике: глава плеера и вид входа (клип, карточка, карточка опор). */
export interface AnimaticShot {
  id: string;
  title: string;
  original: string;
  sequence: string;
  sequenceTitle: string;
  start: number;
  end: number;
  frames: number;
  action: string;
  camera: string;
  lipsync: boolean;
  media: 'video' | 'card' | 'keyframes';
  /** Абсолютный путь карточки для планов без клипа. */
  cardPath: string | null;
  lastCardPath: string | null;
}

export interface AnimaticApproval {
  status: 'none' | 'review' | 'approved';
  approvedSha256: string | null;
  /** Принята именно текущая сборка. */
  current: boolean;
}

export interface AnimaticView {
  built: {
    videoPath: string | null;
    manifestPath: string;
    videoSha256: string | null;
    duration: number;
    totalFrames: number;
    builtAt: string;
    /** Сборка сделана по текущему plan/scenes.json. */
    fresh: boolean;
    counts: { video: number; cards: number; keyframes: number };
  } | null;
  shots: AnimaticShot[];
  approval: AnimaticApproval;
  /** Карточки plan/animatic/cards нарисованы по текущему реестру. */
  cardsFresh: boolean;
  problems: string[];
}

/** Дашборд сцен: всё известное о плане в одной карточке; только чтение. */
export interface DashboardShot {
  id: string;
  title: string;
  sequenceTitle: string;
  original: string;
  start: number;
  end: number;
  frames: number;
  camera: string;
  action: string;
  continuity: string;
  notes: string;
  lipsync: boolean;
  references: { id: string; name: string; imagePath: string | null }[];
  state: ShotProductionState;
  stageLabel: string;
  /** Комплект в assets/shots: оригинал против принятого монтажа, рецепт, промпт, входы. */
  asset: {
    dir: string;
    video: string | null;
    original: string | null;
    originalMedia: string | null;
    edit: {
      frames: number;
      duration: number;
      sourceInterval: [number, number] | null;
      stillAt: number | null;
      speed: string;
      holdFirst: number;
      holdLast: number;
      note: string;
    };
    prompt: string | null;
    request: { provider: string; model: string; parameters: Record<string, unknown> } | null;
    inputs: { path: string; role: string }[];
    lipsync: boolean;
    audio: string | null;
  } | null;
  /** Последний пакет плана, если комплекта ещё нет. */
  package: {
    dir: string;
    stageLabel: string;
    prompt: string | null;
    request: { model: string; parameters: Record<string, unknown>; downloads: string[] } | null;
    preview: string[];
  } | null;
  packagesCount: number;
  thumbnail: string | null;
  /** Опоры: входы принятого запроса или кандидаты и принятые опоры последнего пакета. */
  keyframes: { imagePath: string; label: string; approved: boolean }[];
  cardPath: string | null;
  animaticMedia: 'video' | 'card' | 'keyframes' | null;
  /** Состояние и его строки с подписями из словаря свойств (как во врезке непрерывности). */
  before: { state: EntityState; lines: string[]; checklist: string[] } | null;
  after: { state: EntityState; lines: string[]; checklist: string[] } | null;
}

export interface DashboardView {
  shots: DashboardShot[];
  summary: { total: number; completed: number; progress: number; planned: number; duration: number; completedSeconds: number };
  problems: string[];
}
