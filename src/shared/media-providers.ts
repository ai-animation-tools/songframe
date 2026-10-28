/** Возможности media-провайдеров независимы от текстового агента и не разрешают запуск генерации. */
import type { AgentProvider } from './agent-providers';

export type MediaKind = 'image' | 'video';

/** Реестр провайдеров медиа: общий код и интерфейс узнают о провайдере только отсюда, а не сравнением имён. */
export interface MediaProviderInfo {
  title: string;
  kinds: readonly MediaKind[];
  /** Программа-агент, которую приложение запускает для генерации; null — провайдер вызывается напрямую. */
  executor: AgentProvider | null;
  /** Платный замороженный запрос: цена, баланс и отдельное подтверждение отправки. */
  paid: boolean;
  /**
   * Липсинк видео по точному звуку: допустимая длина звукового входа в секундах; null — провайдер не синхронизирует губы с заданным звуком.
   * Речевой план с таким провайдером не готовится: приложение блокирует действия и объясняет причину.
   */
  lipSync: { min: number; max: number } | null;
  /** Сервис не сообщает цену заранее: приложение запоминает фактическое списание и показывает цену для такой же конфигурации запроса. */
  learnsPriceFromCharges: boolean;
  /**
   * Где пользователь видит свои генерации у сервиса. По ней выясняется неизвестный исход отправки: ID задания там не показан,
   * но найденный результат можно скачать и загрузить в попытку. Текст продолжает фразу «откройте …», поэтому в винительном падеже.
   * null — у провайдера нет платной отправки с неизвестным исходом.
   */
  generationHistory: string | null;
  /** Разрешение, пропорции и число вариантов задаются в настройках проекта. */
  requestParameters: boolean;
  /** Подпись пустой модели в настройках проекта. */
  defaultModelLabel: string;
  /** Что подтверждает и чего не подтверждает проверка возможностей. */
  capabilitiesNote: string;
  /** Наблюдения о провайдере для настроек проекта по виду медиа; показываются только при выбранном провайдере. */
  settingsNotes: Partial<Record<MediaKind, string>>;
  /** Значения параметров запроса, которые провайдер применяет при пустой настройке проекта. */
  defaults: Partial<Record<MediaKind, MediaRequestDefaults>>;
  /** Порядок известных моделей в настройках проекта; сам каталог объявляет провайдер. */
  modelOrder: Partial<Record<MediaKind, readonly string[]>>;
  /** Подписи команд провайдера в интерфейсе; команда без подписи показывается своим именем. */
  commandLabels: Readonly<Record<string, string>>;
}
/** Параметры запроса по умолчанию для вида медиа. */
export interface MediaRequestDefaults {
  resolution?: string;
  aspect_ratio?: string;
  outputs?: number;
}

/** Реестр изменяем только тестами через registerMediaProviderForTests. */
export const MEDIA_PROVIDERS: Record<MediaProviderId, MediaProviderInfo> = {
  kling: {
    title: 'Kling',
    kinds: ['image', 'video'],
    executor: null,
    paid: true,
    // Звуковые слоты audio_N режима omni_ref_video (kling-video-v4_0): 5–30 с по объявлению who_am_i.
    lipSync: { min: 5, max: 30 },
    learnsPriceFromCharges: true,
    generationHistory: 'галерею созданных работ на сайте kling.ai (раздел Creations, адрес kling.ai/app/creations)',
    requestParameters: true,
    defaultModelLabel: 'Автоматически по задаче',
    capabilitiesNote: 'Проверка не запускает генерацию и не тратит кредиты. Подойдёт ли модель для конкретного плана, приложение проверит перед запросом.',
    settingsNotes: {},
    defaults: { image: { resolution: '2k', aspect_ratio: '16:9', outputs: 1 } },
    modelOrder: {
      image: [
        'gpt-image-2',
        'gpt-image2',
        'gemini-3-pro-image',
        'gemini-3.1-flash-image',
        'kling-image-v3_0_omni',
        'kling-image-o1',
        'kling-image-v3_0',
        'kling-image-v2_1'
      ],
      video: [
        'kling-video-v4_0',
        'kling-video-v3_0_omni',
        'kling-video-v3_0',
        'kling-video-v3_0_turbo',
        'kling-video-o1',
        'kling-video-v2_6',
        'kling-video-v2_5'
      ]
    },
    commandLabels: {
      text_to_video: 'видео по тексту',
      image_to_video: 'видео по опорным кадрам',
      omni_ref_video: 'видео по референсам',
      motion_control: 'видео по движению'
    }
  },
  codex: {
    title: 'Codex',
    kinds: ['image'],
    executor: 'codex',
    paid: false,
    lipSync: null,
    learnsPriceFromCharges: false,
    generationHistory: null,
    requestParameters: false,
    defaultModelLabel: 'Как указано в настройках Codex',
    capabilitiesNote: 'Проверка не создаёт изображений. Сможет ли Codex их нарисовать, станет ясно при первой генерации.',
    settingsNotes: {
      image:
        'В наших проверках горизонтальные изображения получались размером 1672×941, в том числе при запросе 4K. Точный размер через промпт не гарантируется.'
    },
    defaults: {},
    modelOrder: {},
    commandLabels: {}
  }
};

/** ID провайдера — данные реестра: общий код не перечисляет конкретные сервисы в типах. */
export type MediaProviderId = string;

export const MEDIA_PROVIDER_IDS: MediaProviderId[] = Object.keys(MEDIA_PROVIDERS);

/**
 * Тестовая регистрация провайдера (например, `test`): единственный способ тестам дополнить реестр.
 * Возвращает откат, восстанавливающий прежнее состояние.
 */
export function registerMediaProviderForTests(id: MediaProviderId, info: MediaProviderInfo): () => void {
  const previous = Object.hasOwn(MEDIA_PROVIDERS, id) ? MEDIA_PROVIDERS[id] : undefined;
  MEDIA_PROVIDERS[id] = info;
  if (!MEDIA_PROVIDER_IDS.includes(id)) MEDIA_PROVIDER_IDS.push(id);
  return () => {
    if (previous) {
      MEDIA_PROVIDERS[id] = previous;
      return;
    }
    delete MEDIA_PROVIDERS[id];
    MEDIA_PROVIDER_IDS.splice(MEDIA_PROVIDER_IDS.indexOf(id), 1);
  };
}

export function isMediaProvider(value: unknown, kind: MediaKind): value is MediaProviderId {
  return typeof value === 'string' && Object.hasOwn(MEDIA_PROVIDERS, value) && MEDIA_PROVIDERS[value].kinds.includes(kind);
}

/** Порядок совпадает с порядком вариантов в настройках проекта. */
export function mediaProvidersFor(kind: MediaKind): MediaProviderId[] {
  return MEDIA_PROVIDER_IDS.filter((id) => isMediaProvider(id, kind));
}

/** Имя из сохранённого запроса или настроек: регистр и крайние пробелы несущественны. */
export function normalizeMediaProvider(value: unknown): MediaProviderId | null {
  if (typeof value !== 'string') return null;
  const id = value.trim().toLowerCase();
  return Object.hasOwn(MEDIA_PROVIDERS, id) ? id : null;
}

/** Замороженный запрос отправляется и получается только у провайдера с платным исполнителем. */
export function isPaidMediaProvider(value: unknown): boolean {
  const id = normalizeMediaProvider(value);
  return !!id && MEDIA_PROVIDERS[id].paid;
}

/** Названия провайдеров вида медиа для сообщений: «Первый или Второй». */
export function mediaProviderTitles(kind: MediaKind): string {
  return mediaProvidersFor(kind)
    .map((id) => MEDIA_PROVIDERS[id].title)
    .join(' или ');
}

/** Сведения о провайдере из сохранённой строки; неизвестное значение даёт null. */
export function mediaProviderInfo(value: unknown, kind: MediaKind): MediaProviderInfo | null {
  return isMediaProvider(value, kind) ? MEDIA_PROVIDERS[value] : null;
}

/** Имя сервиса в сохранённом запросе и в настройках может отличаться регистром и крайними пробелами. */
export function sameMediaProvider(left: unknown, right: unknown): boolean {
  return typeof left === 'string' && typeof right === 'string' && !!left.trim() && !!right.trim() && left.trim().toLowerCase() === right.trim().toLowerCase();
}
/** Состояние входа в платного провайдера по ответу его программы; unknown не означает выход. */
export interface ProviderAuth {
  status: 'authenticated' | 'unauthenticated' | 'unknown';
  message?: string;
}
/** Обоснование выбора замораживается вместе с запросом и показывается при платном согласовании. */
export interface MediaModelSelection {
  preferredModel: string | null;
  selectedModel: string;
  reason: string;
}
export interface MediaArgument {
  required?: boolean;
  default?: unknown;
  allowed?: string[];
  max_items?: number;
  [key: string]: unknown;
}
export interface MediaModel {
  id: string;
  command: string;
  arguments: Record<string, MediaArgument>;
  slots: Record<string, MediaArgument>;
  limits: Record<string, unknown>;
}
export interface MediaCapabilities {
  provider: string;
  kind: MediaKind;
  available: boolean;
  checkedAt: string;
  models: MediaModel[];
  problems: string[];
  /** Наличие CLI само по себе не доказывает доступность генератора конкретного аккаунта. */
  generationVerified: boolean;
}
/** Задание агента-исполнителя различается по agentJobId, замороженная попытка платного провайдера — по requestDir. */
export type MediaExecutionRef = AgentMediaExecutionRef | PaidMediaExecutionRef;
export interface AgentMediaExecutionRef {
  provider: MediaProviderId;
  kind: 'image';
  requestSha: string;
  agentJobId: string;
}
export interface PaidMediaExecutionRef {
  provider: MediaProviderId;
  kind: MediaKind;
  requestSha: string;
  requestDir: string;
}

/** Подпись команды провайдера для интерфейса; без подписи в реестре остаётся имя команды. */
export function mediaCommandLabel(provider: unknown, command: string): string {
  const id = normalizeMediaProvider(provider);
  const labels = id ? MEDIA_PROVIDERS[id].commandLabels : {};
  return Object.hasOwn(labels, command) ? labels[command] : command;
}

/** Название провайдера для сообщений; неизвестное значение остаётся общим словом. */
export function mediaProviderTitle(value: unknown, fallback = 'провайдер генерации'): string {
  const id = normalizeMediaProvider(value);
  return id ? MEDIA_PROVIDERS[id].title : fallback;
}
