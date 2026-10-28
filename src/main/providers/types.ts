/** Контракт адаптеров провайдеров медиа: всё, что относится к конкретному сервису, живёт в папке его адаптера. */
import type { AgentJob, AgentSettings } from '@shared/agents';
import type { AgentMediaExecutionRef, MediaCapabilities, MediaKind, MediaProviderId, ProviderAuth } from '@shared/media-providers';
import type { ProductionImagesInput } from '@shared/production-workflow';
import type { EnvironmentCheck } from '@shared/types';
import type { CoverCandidateRunner, CoverManager } from '../cover-generation';
import type { KeyframeImages } from '../keyframe-images';
import type { MediaArtifact } from '../media-providers';
import type { PythonOptions } from '../python-runtime';
import type { SettingsStore } from '../settings';

/** Правила нормализации замороженного запроса, которые общий платный адаптер получает из конфигурации провайдера. */
export interface PaidRequestRules {
  /** Синонимы параметров по виду медиа: каноническое имя → все его написания у провайдера. */
  aliases: Partial<Record<MediaKind, Record<string, readonly string[]>>>;
  /** Имена параметра числа результатов; модель без него даёт ровно один результат. */
  outputCount: readonly string[];
  /** Короткие флаги входов и шаблоны объявленных слотов, в которые они раскрываются до фиксации SHA. */
  inputFlags: Record<string, RegExp>;
  /** Значения, которые приложение задаёт всегда, если модель объявляет параметр; запрещённое явное значение — ошибка. */
  enforced: Record<string, { value: unknown; rejected: readonly unknown[]; message: string }>;
  /** Запрос одного изображения: опора или обложка. */
  image: {
    command(references: number): string;
    /** Именованный слот N-го переданного референса (с нуля). */
    referenceSlot(index: number): string;
    /** Параметр серии изображений: для одной опоры и обложки серия выключается. */
    series?: { names: readonly string[]; off: unknown };
  };
  /** Команды видео, которые агент видит до этапа запроса у плана без липсинка; без поля — все команды вида. */
  draftVideoCommands?: readonly string[];
}

/** Обновление строки проверки среды по её id. */
export type EnvironmentUpdate = (id: string, patch: Partial<EnvironmentCheck>) => void;

export interface ProviderEnvironment {
  /** Начальные строки страницы «Среда» в порядке показа. */
  checks: EnvironmentCheck[];
  /** Проверить строки и сообщить результаты через update. */
  run(update: EnvironmentUpdate): Promise<void>;
}

/** Проверка packaged-поставки: Python-код печатает JSON-результат. */
export interface ProviderSmokeCheck {
  name: string;
  code: string;
}

/** Управление входом: адрес авторизации открывает приложение и показывает его на странице, отмена прерывает ожидание. */
export interface LoginControl {
  signal?: AbortSignal;
  authorizeUrl?(url: string): void;
}

/** Платный провайдер: общий адаптер с конфигурацией, вход и проверки клиента сервиса. */
export interface PaidProviderAdapter {
  readonly type: 'paid';
  readonly id: MediaProviderId;
  readonly rules: PaidRequestRules;
  /** Клиент провайдера доступен для производства; не запускает генерацию и не обращается к сети. */
  installed(options: PythonOptions): boolean;
  environment(options: PythonOptions): ProviderEnvironment;
  checkAuth(options: PythonOptions): Promise<ProviderAuth>;
  login(options: PythonOptions, control?: LoginControl): Promise<{ ok: boolean; message: string }>;
  /** Проверки packaged-поставки без внешнего окружения. */
  smokeChecks(options: PythonOptions): ProviderSmokeCheck[];
}

/** Общие зависимости исполнителя опор провайдера-агента. */
export interface AgentImageDeps {
  /** Запуск и сбор заданий опор менеджером агентов. */
  images: KeyframeImages;
  /** Программа-агент провайдера по реестру с моделью из настроек проекта. */
  agentSettings: (model?: string) => AgentSettings;
}

/** Зависимости исполнителя обложки провайдера-агента. */
export interface AgentCoverDeps {
  /** Программа-агент и модель, закреплённые при подготовке. */
  config: AgentSettings;
  /** Менеджер заданий временного проекта обложки; тесты подменяют его. */
  createManager?: (settings: SettingsStore) => CoverManager;
}

/** Подготовленный запрос опор: SHA согласуется до отправки. */
export interface AgentImagePrepared {
  requestSha: string;
}

/** Исполнитель опор провайдера-агента: возможности, подготовка, одноразовая отправка и сбор результата. */
export interface AgentImageExecutor {
  readonly provider: MediaProviderId;
  capabilities(project: string): Promise<MediaCapabilities>;
  prepare(input: ProductionImagesInput): AgentImagePrepared;
  submit(prepared: AgentImagePrepared, permit: { requestSha: string }): AgentMediaExecutionRef;
  collectJob(job: AgentJob): MediaArtifact[];
}

/** Провайдер, генерацию которого исполняет программа-агент из реестра (MediaProviderInfo.executor). */
export interface AgentProviderAdapter {
  readonly type: 'agent';
  readonly id: MediaProviderId;
  /** Исполнитель опор; общий код получает его из таблицы адаптеров, не зная конкретного сервиса. */
  images(deps: AgentImageDeps): AgentImageExecutor;
  /** Исполнитель обложки проекта. */
  cover(deps: AgentCoverDeps): CoverCandidateRunner;
}

export type MediaProviderAdapter = PaidProviderAdapter | AgentProviderAdapter;
