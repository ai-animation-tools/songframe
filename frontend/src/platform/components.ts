import type * as dto from '../../bindings/songframe-go/internal/components/models';
import { ApiError } from './api';
import { componentTexts } from '@shared/texts/components';

/** Типы происходят из Go bindings; массивы и maps уточняются после проверки wire-ответа. */
export type Selection = dto.Selection;
export type ComponentState = Omit<dto.ComponentState, 'paths'> & { paths: Record<string, string> };
export type OperationState = Omit<dto.OperationState, 'requires'> & { requires: string[] };
export type Snapshot = Omit<dto.Snapshot, 'components' | 'operations'> & {
  components: ComponentState[];
  operations: OperationState[];
};
export type InstallPackage = dto.InstallPackage;
export type InstallLog = dto.InstallLog;
export type InstallSnapshot = Omit<dto.InstallSnapshot, 'log'> & { log: InstallLog[] };
export type InstallRequest = Omit<dto.InstallRequest, 'components' | 'localFiles'> & {
  components: string[];
  localFiles: Record<string, string>;
};

/** Страница владеет только ожиданием: сама установка и её отмена продолжают принадлежать Go. */
export interface ComponentsApi {
  state(): Promise<Snapshot>;
  connect(component: string): Promise<Snapshot | null>;
  download(components: string[]): Promise<InstallSnapshot>;
  configure(selection: Selection): Promise<Snapshot>;
  check(operations: string[], force: boolean): Promise<Snapshot>;
  cancel(): Promise<void>;
  catalog(): Promise<InstallPackage[]>;
  installation(): Promise<InstallSnapshot>;
  install(request: InstallRequest): Promise<InstallSnapshot>;
  cancelInstall(): Promise<void>;
  chooseDirectory(component?: string): Promise<string | null>;
  chooseFile(component: string): Promise<string | null>;
}

/** Transport остаётся подменяемым без загрузки Wails: истории используют локальную модель API. */
export interface ComponentsTransport {
  state(): Promise<unknown>;
  connect(component: string): Promise<unknown>;
  download(components: string[]): Promise<unknown>;
  configure(selection: Selection): Promise<unknown>;
  check(operations: string[], force: boolean): Promise<unknown>;
  cancel(): Promise<void>;
  catalog(): Promise<unknown>;
  installation(): Promise<unknown>;
  install(request: InstallRequest): Promise<unknown>;
  cancelInstall(): Promise<void>;
  chooseDirectory(component?: string): Promise<string | null>;
  chooseFile(component: string): Promise<string | null>;
}

const record = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every((item) => typeof item === 'string');
const fields = (value: Record<string, unknown>, names: string[]) => names.every((name) => typeof value[name] === 'string');
const count = (value: unknown): value is number => Number.isSafeInteger(value) && Number(value) >= 0;
const stringMap = (value: unknown): value is Record<string, string> => record(value) && Object.values(value).every((item) => typeof item === 'string');

/** Повреждённый ответ не превращается в ложную готовность компонента или успех установки. */
function invalid(method: string): never {
  throw new ApiError('INVALID_RESPONSE', method, componentTexts.invalidResponse);
}

/** Статусы остаются строками Go: renderer показывает объяснение и для будущего неизвестного состояния. */
export function componentSnapshot(value: unknown): Snapshot {
  if (
    !record(value) ||
    !record(value.selection) ||
    !fields(value.selection, [
      'ffmpegDirectory',
      'ortDirectory',
      'ortLibraryFile',
      'vocalsFile',
      'ctcDirectory',
      'ctcModelFile',
      'ctcVocabFile',
      'managedDirectory'
    ]) ||
    typeof value.checking !== 'boolean' ||
    typeof value.problem !== 'string' ||
    !Array.isArray(value.components) ||
    !value.components.every((item) => record(item) && fields(item, ['id', 'status', 'reason', 'source', 'version']) && stringMap(item.paths)) ||
    !Array.isArray(value.operations) ||
    !value.operations.every((item) => record(item) && fields(item, ['id', 'status', 'reason']) && strings(item.requires))
  )
    invalid('components.state');
  return value as Snapshot;
}

/** Размеры передаются в байтах и остаются безопасными целыми числами для UI-прогресса. */
export function installCatalog(value: unknown): InstallPackage[] {
  if (
    !Array.isArray(value) ||
    !value.every(
      (item) =>
        record(item) &&
        fields(item, ['component', 'id', 'version', 'license', 'url', 'reason']) &&
        ['bytes', 'installBytes', 'temporaryBytes'].every((name) => count(item[name])) &&
        typeof item.supported === 'boolean'
    )
  )
    invalid('components.catalog');
  return value as InstallPackage[];
}

/** Журнал читается отдельным снимком: поздний poll не завершает Promise работающей установки. */
export function installSnapshot(value: unknown): InstallSnapshot {
  if (
    !record(value) ||
    !fields(value, ['status', 'component', 'message']) ||
    !count(value.completedBytes) ||
    !count(value.totalBytes) ||
    !Array.isArray(value.log) ||
    !value.log.every((item) => record(item) && fields(item, ['time', 'message']))
  )
    invalid('components.installation');
  return value as InstallSnapshot;
}

/** Длительные Install/Check не получают таймаут оболочки: отменой управляет явная кнопка Go. */
export function createComponentsApi(transport: ComponentsTransport): ComponentsApi {
  return {
    state: async () => componentSnapshot(await transport.state()),
    connect: async (component) => {
      const result = await transport.connect(component);
      return result === null ? null : componentSnapshot(result);
    },
    download: async (components) => installSnapshot(await transport.download(components)),
    configure: async (selection) => componentSnapshot(await transport.configure(selection)),
    check: async (operations, force) => componentSnapshot(await transport.check(operations, force)),
    cancel: () => transport.cancel(),
    catalog: async () => installCatalog(await transport.catalog()),
    installation: async () => installSnapshot(await transport.installation()),
    install: async (request) => installSnapshot(await transport.install(request)),
    cancelInstall: () => transport.cancelInstall(),
    chooseDirectory: (component) => transport.chooseDirectory(component),
    chooseFile: (component) => transport.chooseFile(component)
  };
}

/** Импорт bindings отложен до действия пользователя, поэтому витрина не запускает нативные вызовы. */
const service = () => import('../../bindings/songframe-go/internal/app/componentsservice');
const native = () => import('../../bindings/songframe-go/internal/app/nativeservice');
export const nativeComponentsApi: ComponentsApi = createComponentsApi({
  state: async () => (await service()).State(),
  connect: async (component) => {
    const path = await (await native()).PickComponentFile(component);
    if (path === null) return null;
    return (await service()).Connect(component, path);
  },
  download: async (components) => (await service()).Download(components),
  configure: async (selection) => (await service()).Configure(selection),
  check: async (operations, force) => (await service()).Check(operations, force),
  cancel: async () => {
    await (await service()).Cancel();
  },
  catalog: async () => (await service()).Catalog(),
  installation: async () => (await service()).Installation(),
  install: async (request) => (await service()).Install(request),
  cancelInstall: async () => {
    await (await service()).CancelInstall();
  },
  chooseDirectory: async (component) => {
    // Заголовок связывает системный диалог с карточкой: одинаковые кнопки не должны путать FFmpeg и ORT.
    const title =
      component === 'ffmpeg'
        ? componentTexts.selectFFmpegFolder
        : component === 'ort-cpu'
          ? componentTexts.selectORTFolder
          : component === 'ctc-ru' || component === 'ctc-vocab'
            ? componentTexts.selectCTCFolder
            : componentTexts.selectManagedFolder;
    return (await native()).PickFolder({ title });
  },
  chooseFile: async (component) =>
    (
      await (
        await native()
      ).PickFiles({
        title: componentTexts.selectOfflineFile(componentTexts.names[component] ?? component),
        multiple: false
      })
    )?.[0] ?? null
});
