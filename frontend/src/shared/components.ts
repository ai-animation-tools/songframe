/** Контракт группы window.api.components: DTO принадлежат Go (internal/components), TS берёт их из bindings. */
import type * as dto from '../../bindings/songframe-go/internal/components/models';

export type ComponentsSelection = dto.Selection;
export type ComponentState = dto.ComponentState;
export type ComponentOperation = dto.OperationState;
export type ComponentsSnapshot = dto.Snapshot;
export type ComponentPackage = dto.InstallPackage;
export type ComponentInstallLog = dto.InstallLog;
export type ComponentInstallation = dto.InstallSnapshot;
export type ComponentInstallRequest = dto.InstallRequest;

/** Внешние программы и модели вне базового пакета (FFmpeg, ONNX Runtime, CTC): поиск, подключение, установка. */
export interface ComponentsApi {
  state(): Promise<ComponentsSnapshot>;
  /** Системный диалог выбора готового файла или архива; null — пользователь отменил выбор. */
  connect(component: string): Promise<ComponentsSnapshot | null>;
  download(components: string[]): Promise<ComponentInstallation>;
  configure(selection: ComponentsSelection): Promise<ComponentsSnapshot>;
  check(operations: string[], force: boolean): Promise<ComponentsSnapshot>;
  cancel(): Promise<void>;
  catalog(): Promise<ComponentPackage[]>;
  installation(): Promise<ComponentInstallation>;
  install(request: ComponentInstallRequest): Promise<ComponentInstallation>;
  cancelInstall(): Promise<void>;
  chooseDirectory(component?: string): Promise<string | null>;
  chooseFile(component: string): Promise<string | null>;
}
